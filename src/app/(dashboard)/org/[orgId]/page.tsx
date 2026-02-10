import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { LayoutDashboard, Users, BookOpen, ClipboardList, Award, TrendingUp } from "lucide-react";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";
import { fetchEnrollmentTestSummary, formatDurationSeconds } from "@/services/reporting.service";
import { RecentActivityTableV2, type RecentActivityItemV2 } from "@/components/table-v2/RecentActivityTableV2";

type Stat = { label: string; value: string; icon: typeof Users; color: string; error?: string | null };

export const fetchCache = "force-no-store";

async function safeCount(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  table: string,
  filters?: Array<{ column: string; value: unknown }>
) {
  try {
    let q = admin.from(table).select("*", { count: "exact", head: true });
    for (const f of filters ?? []) {
      q = q.eq(f.column, f.value);
    }
    const { count, error } = await q;
    return { count: typeof count === "number" ? count : 0, error: error?.message ?? null };
  } catch (e) {
    return { count: 0, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

interface OrgDashboardProps {
  params: Promise<{ orgId: string }>;
}

export default async function OrgDashboardPage({ params }: OrgDashboardProps) {
  const { user, error } = await getServerUser();
  if (error || !user) redirect("/");

  const { orgId: orgKey } = await params;
  const resolved = await resolveOrgKey(orgKey);
  const org = resolved.org;
  if (!org) {
    if (user.role === "organization_admin" || user.role === "member") redirect("/unauthorized");
    notFound();
  }

  const orgId = org.id; // UUID (DB/API)
  const orgSlug = org.slug; // canonical slug (links)

  // Security: prevent org admins/members from guessing other org URLs.
  if (user.role === "organization_admin" || user.role === "member") {
    if (!user.organization_id || user.organization_id !== orgId) {
      redirect("/unauthorized");
    }
  }

  const admin = createAdminSupabaseClient();

  const canSeeUsersCard = user.role !== "member";
  const noopCount = { count: 0, error: null as string | null };

  const [{ data: orgRow }, usersTotal, usersDisabled, courses, tests, certificates] = await Promise.all([
    admin.from("organizations").select("id, name, slug, logo_url").eq("id", orgId).single(),
    canSeeUsersCard ? safeCount(admin, "users", [{ column: "organization_id", value: orgId }]) : Promise.resolve(noopCount),
    canSeeUsersCard ? safeCount(admin, "users", [
      { column: "organization_id", value: orgId },
      { column: "is_active", value: false },
    ]) : Promise.resolve(noopCount),
    safeCount(admin, "courses", [{ column: "organization_id", value: orgId }]),
    safeCount(admin, "tests", [
      { column: "organization_id", value: orgId },
      { column: "is_published", value: true },
    ]),
    safeCount(admin, "certificates", [{ column: "organization_id", value: orgId }]),
  ]);

  // Treat NULL as active (matches app semantics: only explicit false is disabled)
  const activeUsersCount = Math.max(0, usersTotal.count - usersDisabled.count);
  const usersCountError = usersTotal.error || usersDisabled.error;

  const orgName = (orgRow as { name?: unknown } | null)?.name;
  const orgSlugFromRow = (orgRow as { slug?: unknown } | null)?.slug;
  const orgLogoUrl = (orgRow as { logo_url?: unknown } | null)?.logo_url;
  const orgLabel =
    typeof orgName === "string" && orgName.trim().length > 0
      ? orgName.trim()
      : typeof orgSlugFromRow === "string" && orgSlugFromRow.trim().length > 0
        ? orgSlugFromRow.trim()
        : orgSlug || orgId;

  const stats: Stat[] = [
    ...(canSeeUsersCard
      ? [
          {
            label: "Users (Active / Disabled)",
            value: `${activeUsersCount} / ${usersDisabled.count}`,
            icon: Users,
            color: "bg-blue-500",
            error: usersCountError,
          },
        ]
      : []),
    { label: "Courses", value: String(courses.count), icon: BookOpen, color: "bg-purple-500", error: courses.error },
    { label: "Active Tests", value: String(tests.count), icon: ClipboardList, color: "bg-green-500", error: tests.error },
    { label: "Certificates", value: String(certificates.count), icon: Award, color: "bg-amber-500", error: certificates.error },
  ];

  // Course progress (org admin & above)
  type CourseProgressRow = {
    course_id: string;
    course_title: string;
    enrolled: number;
    passed: number;
    failed: number;
    not_submitted: number;
    pass_rate: number; // 0..1
    avg_assessment_seconds: number | null;
  };

  let courseProgressError: string | null = null;
  let courseProgressRows: CourseProgressRow[] = [];

  if (user.role !== "member") {
    const summary = await fetchEnrollmentTestSummary({ organizationId: orgId, limit: 50000 });
    if (summary.error) {
      courseProgressError = summary.error;
    } else {
      const byCourse: Record<
        string,
        { title: string; enrolled: number; passed: number; failed: number; not_submitted: number; totalSeconds: number; secondsRows: number }
      > = {};

      for (const r of summary.rows) {
        const cid = r.course_id;
        const title = (r.course_title ?? "").trim() || "Untitled course";
        byCourse[cid] = byCourse[cid] || { title, enrolled: 0, passed: 0, failed: 0, not_submitted: 0, totalSeconds: 0, secondsRows: 0 };
        byCourse[cid].enrolled += 1;
        if (r.course_result === "passed") byCourse[cid].passed += 1;
        else if (r.course_result === "failed") byCourse[cid].failed += 1;
        else byCourse[cid].not_submitted += 1;

        if (typeof r.total_duration_seconds === "number" && Number.isFinite(r.total_duration_seconds) && r.total_duration_seconds > 0) {
          byCourse[cid].totalSeconds += r.total_duration_seconds;
          byCourse[cid].secondsRows += 1;
        }
      }

      courseProgressRows = Object.entries(byCourse)
        .map(([course_id, v]) => {
          const pass_rate = v.enrolled > 0 ? v.passed / v.enrolled : 0;
          const avg_assessment_seconds = v.secondsRows > 0 ? Math.round(v.totalSeconds / v.secondsRows) : null;
          return {
            course_id,
            course_title: v.title,
            enrolled: v.enrolled,
            passed: v.passed,
            failed: v.failed,
            not_submitted: v.not_submitted,
            pass_rate,
            avg_assessment_seconds,
          };
        })
        .sort((a, b) => b.enrolled - a.enrolled)
        .slice(0, 8);
    }
  }

  // Recent activity (org-scoped): enrollments, submitted tests, certificates issued.
  type ActivityEvent = { ts: string; type: "enrolled" | "test_submitted" | "certificate_issued"; user_id: string | null; course_id: string | null; test_id?: string | null; score?: number | null; passed?: boolean | null };
  type ActivityEventDisplay = ActivityEvent & { user_label: string; course_label: string; test_label: string | null };

  let activityError: string | null = null;
  let activityEvents: ActivityEventDisplay[] = [];

  if (user.role !== "member") {
    try {
      const [{ data: enrollRows, error: enrollErr }, { data: attemptRows, error: attemptErr }, { data: certRows, error: certErr }] =
        await Promise.all([
          admin
            .from("course_enrollments")
            .select("user_id, course_id, enrolled_at")
            .eq("organization_id", orgId)
            .order("enrolled_at", { ascending: false })
            .limit(12),
          admin
            .from("test_attempts")
            .select("user_id, test_id, submitted_at, score, passed")
            .eq("organization_id", orgId)
            .not("submitted_at", "is", null)
            .order("submitted_at", { ascending: false })
            .limit(12),
          admin
            .from("certificates")
            .select("user_id, course_id, issued_at, created_at, status")
            .eq("organization_id", orgId)
            .order("created_at", { ascending: false })
            .limit(12),
        ]);

      const firstErr = enrollErr?.message ?? attemptErr?.message ?? certErr?.message ?? null;
      if (firstErr) {
        activityError = firstErr;
      } else {
        const events: ActivityEvent[] = [];

        for (const r of (Array.isArray(enrollRows) ? enrollRows : []) as Array<{ user_id?: string | null; course_id?: string | null; enrolled_at?: string | null }>) {
          const ts = typeof r.enrolled_at === "string" ? r.enrolled_at : null;
          if (!ts) continue;
          events.push({ ts, type: "enrolled", user_id: r.user_id ?? null, course_id: r.course_id ?? null });
        }

        for (const r of (Array.isArray(attemptRows) ? attemptRows : []) as Array<{ user_id?: string | null; test_id?: string | null; submitted_at?: string | null; score?: number | null; passed?: boolean | null }>) {
          const ts = typeof r.submitted_at === "string" ? r.submitted_at : null;
          if (!ts) continue;
          events.push({
            ts,
            type: "test_submitted",
            user_id: r.user_id ?? null,
            course_id: null,
            test_id: r.test_id ?? null,
            score: typeof r.score === "number" ? r.score : null,
            passed: typeof r.passed === "boolean" ? r.passed : null,
          });
        }

        for (const r of (Array.isArray(certRows) ? certRows : []) as Array<{ user_id?: string | null; course_id?: string | null; issued_at?: string | null; created_at?: string | null }>) {
          const ts = (typeof r.issued_at === "string" ? r.issued_at : null) ?? (typeof r.created_at === "string" ? r.created_at : null);
          if (!ts) continue;
          events.push({ ts, type: "certificate_issued", user_id: r.user_id ?? null, course_id: r.course_id ?? null });
        }

        // Hydrate user/course/test labels for the small recent set
        const userIds = Array.from(new Set(events.map((e) => e.user_id).filter((v): v is string => typeof v === "string" && v.length > 0)));
        const courseIds = Array.from(new Set(events.map((e) => e.course_id).filter((v): v is string => typeof v === "string" && v.length > 0)));
        const testIds = Array.from(new Set(events.map((e) => e.test_id).filter((v): v is string => typeof v === "string" && v.length > 0)));

        const [{ data: usersData }, { data: coursesData }, { data: testsData }] = await Promise.all([
          userIds.length > 0 ? admin.from("users").select("id, full_name, email").in("id", userIds) : Promise.resolve({ data: [] }),
          courseIds.length > 0 ? admin.from("courses").select("id, title").in("id", courseIds) : Promise.resolve({ data: [] }),
          testIds.length > 0 ? admin.from("tests").select("id, title, course_id").in("id", testIds) : Promise.resolve({ data: [] }),
        ]);

        const userLabelById = new Map<string, string>();
        for (const u of (Array.isArray(usersData) ? usersData : []) as Array<{ id?: unknown; full_name?: unknown; email?: unknown }>) {
          const id = typeof u.id === "string" ? u.id : null;
          if (!id) continue;
          const fullName = typeof u.full_name === "string" && u.full_name.trim().length ? u.full_name.trim() : null;
          const email = typeof u.email === "string" && u.email.trim().length ? u.email.trim() : null;
          userLabelById.set(id, fullName ?? email ?? id);
        }

        const courseLabelById = new Map<string, string>();
        for (const c of (Array.isArray(coursesData) ? coursesData : []) as Array<{ id?: unknown; title?: unknown }>) {
          const id = typeof c.id === "string" ? c.id : null;
          if (!id) continue;
          const title = typeof c.title === "string" && c.title.trim().length ? c.title.trim() : null;
          courseLabelById.set(id, title ?? "Untitled course");
        }

        const testLabelById = new Map<string, { title: string; course_id: string | null }>();
        for (const t of (Array.isArray(testsData) ? testsData : []) as Array<{ id?: unknown; title?: unknown; course_id?: unknown }>) {
          const id = typeof t.id === "string" ? t.id : null;
          if (!id) continue;
          const title = typeof t.title === "string" && t.title.trim().length ? t.title.trim() : "Assessment";
          const course_id = typeof t.course_id === "string" && t.course_id.length > 0 ? t.course_id : null;
          testLabelById.set(id, { title, course_id });
        }

        // Backfill course_id for test events from test mapping.
        const enriched = events.map((e) => {
          if (e.type === "test_submitted" && !e.course_id) {
            const tid = e.test_id ?? null;
            const cId = tid ? (testLabelById.get(tid)?.course_id ?? null) : null;
            return { ...e, course_id: cId };
          }
          return e;
        });

        // Final render list (most recent first)
        activityEvents = enriched
          .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
          .slice(0, 12)
          .map((e) => ({
            ...e,
            user_label: e.user_id ? (userLabelById.get(e.user_id) ?? e.user_id) : "Unknown user",
            course_label: e.course_id ? (courseLabelById.get(e.course_id) ?? e.course_id) : "Unknown course",
            test_label: e.test_id ? (testLabelById.get(e.test_id)?.title ?? e.test_id) : null,
          }));
      }
    } catch (e) {
      activityError = e instanceof Error ? e.message : "Failed to load activity";
    }
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col items-start gap-3">
        {typeof orgLogoUrl === "string" && orgLogoUrl.trim().length > 0 ? (
          <div className="h-12 w-auto rounded bg-transparent my-5 flex items-center justify-center overflow-hidden">
            <Image
              src={orgLogoUrl}
              alt={`${orgLabel} logo`}
              width={160}
              height={64}
              className="h-full w-full object-contain"
              priority
            />
          </div>
        ) : (
          <LayoutDashboard className="h-8 w-8 text-primary" />
        )}
        <div>
          <h1 className="text-2xl font-bold text-foreground">Organization Dashboard</h1>
          <p className="text-muted-foreground">
            {typeof orgName === "string" && orgName.trim().length > 0 ? "Organization Name" : "Organization"}:{" "}
            <span className="font-medium text-foreground">{orgLabel}</span>
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {user.full_name && user.full_name.trim().length > 0
              ? `Welcome back, ${user.full_name.trim()}`
              : "Welcome back"}
          </p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className="bg-card border rounded-lg p-6 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{stat.label}</p>
                  <p className="text-3xl font-bold text-foreground mt-1">{stat.value}</p>
                  {stat.error ? (
                    <p className="mt-1 text-xs text-destructive">
                      {stat.error.includes("relation") ? "Missing table / schema" : stat.error}
                    </p>
                  ) : null}
                </div>
                <div className={`${stat.color} p-3 rounded-lg`}>
                  <Icon className="h-6 w-6 text-white" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Quick Overview Panels */}
      <div className="grid grid-cols-1 md:grid-cols-1 gap-6">
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            Course Progress
          </h2>
          {user.role === "member" ? (
            <div className="text-muted-foreground text-center py-8">
              <p>Course progress is available for administrators.</p>
            </div>
          ) : courseProgressError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              Failed to load course progress: {courseProgressError}
            </div>
          ) : courseProgressRows.length === 0 ? (
            <div className="text-muted-foreground text-center py-8">
              <p>No enrollments yet.</p>
              <p className="text-sm mt-2">Once users enroll, course progress will show here.</p>
            </div>
          ) : (
            <div className="rounded-lg border">
              <div className="w-full overflow-x-auto">
                <table className="min-w-max w-full">
                <thead className="bg-muted/50 border-b">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Course</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Enrollments</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Passed</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Failed</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Not Submitted</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Avg Assessment</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Pass Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {courseProgressRows.map((r) => {
                    const pct = Math.round((Number.isFinite(r.pass_rate) ? r.pass_rate : 0) * 100);
                    return (
                      <tr key={r.course_id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="min-w-[220px]">
                            <div className="font-medium text-foreground">{r.course_title}</div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-foreground tabular-nums">{r.enrolled}</td>
                        <td className="px-4 py-3 text-right text-sm text-foreground tabular-nums">{r.passed}</td>
                        <td className="px-4 py-3 text-right text-sm text-foreground tabular-nums">{r.failed}</td>
                        <td className="px-4 py-3 text-right text-sm text-foreground tabular-nums">{r.not_submitted}</td>
                        <td className="px-4 py-3 text-right text-sm text-muted-foreground whitespace-nowrap">
                          {formatDurationSeconds(r.avg_assessment_seconds)}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-foreground whitespace-nowrap">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-20 h-2 bg-muted rounded-full overflow-hidden">
                              <div className="h-full bg-green-500" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                            </div>
                            <span className="tabular-nums">{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Recent Activity
          </h2>
          {user.role === "member" ? (
            <div className="text-muted-foreground text-center py-8">
              <p>Recent activity is available for administrators.</p>
            </div>
          ) : activityError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              Failed to load activity: {activityError}
            </div>
          ) : activityEvents.length === 0 ? (
            <div className="text-muted-foreground text-center py-8">
              <p>No recent activity yet.</p>
              <p className="text-sm mt-2">Enrollments, test submissions and certificates will appear here.</p>
            </div>
          ) : (
            <RecentActivityTableV2
              items={activityEvents.map((e, idx): RecentActivityItemV2 => {
                const time = e.ts ? new Date(e.ts).toLocaleString() : "-";
                const actor = e.user_label; // Option 1: Actor = user_label
                const subject = e.course_label; // Option 1: Subject = course_label

                let title = "";
                if (e.type === "enrolled") title = "Enrolled";
                else if (e.type === "certificate_issued") title = "Certificate issued";
                else title = e.passed === true ? "Test passed" : e.passed === false ? "Test failed" : "Test submitted";

                const scoreText = e.type === "test_submitted" && typeof e.score === "number" ? `Score: ${e.score}%` : null;
                const testText = e.test_label ? `Test: ${e.test_label}` : null;
                const details = [testText, scoreText].filter((v): v is string => typeof v === "string" && v.length > 0).join("\n");

                return {
                  id: `${e.type}-${e.ts}-${idx}`,
                  time,
                  actor,
                  subject,
                  title,
                  details: details.length ? details : null,
                  meta: e,
                };
              })}
              emptyTitle="No recent activity yet."
              emptySubtitle="Enrollments, test submissions and certificates will appear here."
            />
          )}
        </div>
      </div>
    </div>
  );
}

