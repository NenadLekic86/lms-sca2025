import { BarChart3, Users, BookOpen, Award, TrendingUp } from "lucide-react";
import Link from "next/link";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { RecentEnrollmentsTableV2, type RecentEnrollmentItemV2 } from "@/components/table-v2/RecentEnrollmentsTableV2";
import { ReportFiltersClient } from "@/features/reporting/components/ReportFiltersClient";
import {
  fetchEnrollmentsDaily,
  fetchEnrollmentTestSummaryPage,
  fetchTopCourses,
  fetchTopUsersByPasses,
} from "@/services/reporting.service";

type SearchParams = Record<string, string | string[] | undefined>;
function spGet(sp: SearchParams, key: string): string | null {
  const v = sp[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : null;
  return null;
}

function buildPager(current: number, total: number): Array<number | "ellipsis"> {
  const t = Math.max(1, Math.floor(total));
  const c = Math.min(Math.max(1, Math.floor(current)), t);
  if (t <= 7) return Array.from({ length: t }, (_, i) => i + 1);

  const pages = new Set<number>([1, t, c, c - 1, c + 1]);
  const list = Array.from(pages).filter((p) => p >= 1 && p <= t).sort((a, b) => a - b);
  const out: Array<number | "ellipsis"> = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const prev = list[i - 1];
    if (typeof prev === "number" && p - prev > 1) out.push("ellipsis");
    out.push(p);
  }
  return out;
}

async function safeCount(admin: ReturnType<typeof createAdminSupabaseClient>, table: string) {
  try {
    const { count, error } = await admin.from(table).select("*", { count: "exact", head: true });
    return { count: typeof count === "number" ? count : 0, error: error?.message ?? null };
  } catch (e) {
    return { count: 0, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

async function safeCompletedEnrollments(admin: ReturnType<typeof createAdminSupabaseClient>) {
  try {
    const { count, error } = await admin
      .from("course_enrollments")
      .select("*", { count: "exact", head: true })
      .not("completed_at", "is", null);
    return { count: typeof count === "number" ? count : 0, error: error?.message ?? null };
  } catch (e) {
    return { count: 0, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export default async function SystemReportsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams> | SearchParams;
}) {
  const sp = (await searchParams) ?? {};
  const { user, error } = await getServerUser();
  if (error || !user) return null;
  if (!["super_admin", "system_admin"].includes(user.role)) return null;

  const orgId = spGet(sp, "orgId") ?? "";
  const q = spGet(sp, "q") ?? "";
  const result = (spGet(sp, "result") ?? "all") as "all" | "passed" | "failed" | "not_submitted";
  const from = spGet(sp, "from") ?? "";
  const to = spGet(sp, "to") ?? "";
  const courseId = spGet(sp, "courseId") ?? "";
  const userId = spGet(sp, "userId") ?? "";
  const page = Number(spGet(sp, "page") ?? "1");
  const pageSize = 20;

  const filters = {
    organizationId: orgId || undefined,
    q: q || undefined,
    result,
    from: from || undefined,
    to: to || undefined,
    courseId: courseId || undefined,
    userId: userId || undefined,
  };

  const admin = createAdminSupabaseClient();

  function humanizeSlug(slug: string): string {
    const s = slug.trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ").slice(0, 120);
    if (!s) return "";
    return s
      .split(" ")
      .map((p) => (p.length > 0 ? p[0].toUpperCase() + p.slice(1) : p))
      .join(" ");
  }

  const [orgLookup, courseLookup, userLookup, users, courses, certificates, enrollments, completions, summaryPage, daily, topCoursesRes, topUsersRes] = await Promise.all([
    orgId ? admin.from("organizations").select("name, slug").eq("id", orgId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    courseId ? admin.from("courses").select("title").eq("id", courseId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    userId ? admin.from("users").select("full_name, email").eq("id", userId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    safeCount(admin, "users"),
    safeCount(admin, "courses"),
    safeCount(admin, "certificates"),
    safeCount(admin, "course_enrollments"),
    safeCompletedEnrollments(admin),
    fetchEnrollmentTestSummaryPage({ ...filters, page, pageSize }),
    fetchEnrollmentsDaily({
      organizationId: orgId || undefined,
      days: 14,
      from: from || undefined,
      to: to || undefined,
    }),
    fetchTopCourses({ ...filters, limit: 5 }),
    fetchTopUsersByPasses({ ...filters, limit: 5 }),
  ]);

  const orgLabel = (
    (orgLookup.data && typeof orgLookup.data.name === "string" ? orgLookup.data.name : "") ||
    (orgLookup.data && typeof orgLookup.data.slug === "string" ? humanizeSlug(orgLookup.data.slug) : "")
  ).trim();
  const courseLabel = (courseLookup.data && typeof courseLookup.data.title === "string" ? courseLookup.data.title : "").trim();
  const userLabel = (
    (userLookup.data && typeof userLookup.data.full_name === "string" ? userLookup.data.full_name : "") ||
    (userLookup.data && typeof userLookup.data.email === "string" ? userLookup.data.email : "")
  ).trim();

  const completionRate = enrollments.count > 0 ? Math.round((completions.count / enrollments.count) * 100) : 0;

  const stats = [
    { label: "Total Users", value: String(users.count), icon: Users, error: users.error },
    { label: "Total Courses", value: String(courses.count), icon: BookOpen, error: courses.error },
    { label: "Certificates Issued", value: String(certificates.count), icon: Award, error: certificates.error },
    { label: "Completion Rate", value: `${completionRate}%`, icon: TrendingUp, error: completions.error || enrollments.error },
  ];

  const exportParams = new URLSearchParams();
  if (orgId) exportParams.set("orgId", orgId);
  if (q) exportParams.set("q", q);
  if (result && result !== "all") exportParams.set("result", result);
  if (from) exportParams.set("from", from);
  if (to) exportParams.set("to", to);
  if (courseId) exportParams.set("courseId", courseId);
  if (userId) exportParams.set("userId", userId);
  exportParams.set("max", "50000");
  const exportHref = `/api/reports/enrollments/export?${exportParams.toString()}`;

  const topCourses = topCoursesRes.rows;
  const topUsers = topUsersRes.rows;
  const maxDaily = Math.max(1, ...daily.points.map((p) => p.count));

  const pagerParams = new URLSearchParams();
  if (orgId) pagerParams.set("orgId", orgId);
  if (q) pagerParams.set("q", q);
  if (result && result !== "all") pagerParams.set("result", result);
  if (from) pagerParams.set("from", from);
  if (to) pagerParams.set("to", to);
  if (courseId) pagerParams.set("courseId", courseId);
  if (userId) pagerParams.set("userId", userId);
  const pageHref = (p: number) => {
    const u = new URLSearchParams(pagerParams);
    u.set("page", String(p));
    return `?${u.toString()}`;
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-8 w-8 text-primary shrink-0" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Reports</h1>
            <p className="text-muted-foreground">Analytics and reports across all organizations</p>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button className="gap-2" asChild>
            <a href={exportHref}>Export CSV</a>
          </Button>
        </div>
      </div>

      <ReportFiltersClient
        mode="system"
        initial={{
          q,
          result,
          from,
          to,
          orgId,
          orgLabel,
          courseId,
          courseLabel,
          userId,
          userLabel,
        }}
      />

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="bg-card border rounded-lg p-6 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">{stat.label}</p>
                  <p className="text-3xl font-bold text-foreground mt-1">{stat.value}</p>
                  {stat.error ? (
                    <p className="text-xs text-destructive mt-1">{stat.error}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-1">Live count</p>
                  )}
                </div>
                <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Icon className="h-6 w-6 text-primary" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {daily.error ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Enrollments chart not available: {daily.error}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-card border rounded-lg p-6 shadow-sm lg:col-span-2">
            <h2 className="text-lg font-semibold text-foreground mb-4">Enrollments (daily)</h2>
            <div className="flex items-end gap-1 h-40">
              {daily.points.map((p) => (
                <div key={p.day} className="flex-1 min-w-0">
                  <div
                    className="w-full rounded-sm bg-primary/80"
                    style={{ height: `${Math.round((p.count / maxDaily) * 100)}%` }}
                    title={`${p.day}: ${p.count}`}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted-foreground">
              <span>{daily.points[0]?.day ?? ""}</span>
              <span>{daily.points[daily.points.length - 1]?.day ?? ""}</span>
            </div>
          </div>
          <div className="bg-card border rounded-lg p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-foreground mb-4">Top Courses</h2>
            <div className="space-y-3">
              {topCourses.length === 0 ? (
                <div className="text-sm text-muted-foreground">No data.</div>
              ) : (
                topCourses.map((c) => {
                  const max = Math.max(1, topCourses[0]?.count ?? 1);
                  const w = Math.round((c.count / max) * 100);
                  return (
                    <div key={c.id}>
                      <div className="flex justify-between text-sm">
                        <span className="truncate">{c.label}</span>
                        <span className="tabular-nums text-muted-foreground">{c.count}</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden mt-1">
                        <div className="h-full bg-primary rounded-full" style={{ width: `${w}%` }} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <h2 className="text-lg font-semibold text-foreground mb-4 mt-6">Top Users (by passes)</h2>
            <div className="space-y-3">
              {topUsers.length === 0 ? (
                <div className="text-sm text-muted-foreground">No data.</div>
              ) : (
                topUsers.map((u) => {
                  const max = Math.max(1, topUsers[0]?.count ?? 1);
                  const w = Math.round((u.count / max) * 100);
                  return (
                    <div key={u.id}>
                      <div className="flex justify-between text-sm">
                        <span className="truncate">{u.label}</span>
                        <span className="tabular-nums text-muted-foreground">{u.count}</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden mt-1">
                        <div className="h-full bg-green-600 rounded-full" style={{ width: `${w}%` }} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {summaryPage.error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Failed to load enrollment summary: {summaryPage.error}
        </div>
      ) : (
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground mb-4">Recent Enrollments</h2>

          <RecentEnrollmentsTableV2
            items={summaryPage.rows.map((r, idx): RecentEnrollmentItemV2 => {
              const orgLabel = (r.organization_name ?? "").trim() || "Unnamed organization";
              const userLabel =
                (r.user_full_name && r.user_full_name.trim().length > 0 ? r.user_full_name.trim() : null) ??
                (r.user_email && r.user_email.trim().length > 0 ? r.user_email.trim() : null) ??
                "Unknown user";
              const courseLabel = (r.course_title ?? "").trim() || "Untitled course";

              const time = r.enrolled_at ? new Date(r.enrolled_at).toLocaleString() : "—";
              const id = `${r.organization_id}:${r.user_id}:${r.course_id}:${r.enrolled_at ?? idx}`;

              return {
                id,
                time,
                organization: orgLabel,
                user: userLabel,
                course: courseLabel,
                result: r.course_result,
                enrollmentStatus: r.enrollment_status,
                testTitle: r.test_title,
                attemptCount: r.attempt_count,
                submittedCount: r.submitted_count,
                totalDurationSeconds: r.total_duration_seconds,
                latestAttemptDurationSeconds: r.latest_attempt_duration_seconds,
                latestScore: r.latest_score,
                enrolledAt: r.enrolled_at,
                latestStartedAt: r.latest_started_at,
                latestSubmittedAt: r.latest_submitted_at,
                meta: r,
              };
            })}
            emptyTitle="No enrollments yet."
            emptySubtitle="Once users start enrolling and taking tests, their progress will appear here."
          />

          <div className="mt-4 flex items-center justify-between gap-3 text-sm">
            <div className="text-muted-foreground">
              {summaryPage.count > 0 ? (
                <span>
                  Showing {(summaryPage.page - 1) * summaryPage.pageSize + 1}–
                  {Math.min(summaryPage.page * summaryPage.pageSize, summaryPage.count)} of {summaryPage.count}
                </span>
              ) : (
                <span>Showing 0 results</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {(() => {
                const totalPages = Math.max(1, summaryPage.totalPages);
                const current = Math.min(Math.max(1, summaryPage.page), totalPages);
                const onlyOne = totalPages <= 1;
                const prevDisabled = onlyOne || current <= 1;
                const nextDisabled = onlyOne || current >= totalPages;
                const pager = buildPager(current, totalPages);

                return (
                  <>
                    {prevDisabled ? (
                      <Button variant="outline" disabled>
                        Prev
                      </Button>
                    ) : (
                      <Button asChild variant="outline">
                        <Link href={pageHref(current - 1)}>Prev</Link>
                      </Button>
                    )}

                    <div className="flex items-center gap-1">
                      {pager.map((p, idx) =>
                        p === "ellipsis" ? (
                          <span key={`e-${idx}`} className="px-2 text-muted-foreground select-none">
                            …
                          </span>
                        ) : p === current ? (
                          <Button key={p} disabled>
                            {p}
                          </Button>
                        ) : (
                          <Button key={p} asChild variant="outline">
                            <Link href={pageHref(p)}>{p}</Link>
                          </Button>
                        )
                      )}
                    </div>

                    <div className="text-muted-foreground tabular-nums hidden sm:block">
                      Page {current} / {totalPages}
                    </div>

                    {nextDisabled ? (
                      <Button variant="outline" disabled>
                        Next
                      </Button>
                    ) : (
                      <Button asChild variant="outline">
                        <Link href={pageHref(current + 1)}>Next</Link>
                      </Button>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

