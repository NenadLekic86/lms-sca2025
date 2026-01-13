import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ClipboardList, Play, CheckCircle, XCircle, AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";

export const fetchCache = "force-no-store";

type CourseRow = { id: string; title: string | null };
type TestRow = {
  id: string;
  title: string | null;
  course_id: string;
  max_attempts: number | null;
  pass_score: number | null;
};
type AttemptRow = {
  test_id: string;
  score: number | null;
  passed: boolean | null;
  submitted_at: string | null;
  attempt_number: number | null;
};

export default async function StudentMyTestsPage({ params }: { params: Promise<{ orgId: string }> }) {
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

  if (user.role !== "member") redirect(`/org/${orgSlug}`);
  if (!user.organization_id || user.organization_id !== orgId) redirect("/unauthorized");

  const supabase = await createServerSupabaseClient();

  const { data: enrollments } = await supabase
    .from("course_enrollments")
    .select("course_id")
    .eq("user_id", user.id)
    .eq("organization_id", orgId)
    .eq("status", "active");

  const courseIds = (Array.isArray(enrollments) ? enrollments : [])
    .map((r: { course_id?: string | null }) => r.course_id)
    .filter((v): v is string => typeof v === "string");

  const { data: coursesData } = courseIds.length
    ? await supabase.from("courses").select("id, title").in("id", courseIds)
    : { data: [] };

  const courseMap = new Map<string, CourseRow>();
  (Array.isArray(coursesData) ? (coursesData as CourseRow[]) : []).forEach((c) => courseMap.set(c.id, c));

  const { data: testsData } = courseIds.length
    ? await supabase
        .from("tests")
        .select("id, title, course_id, max_attempts, pass_score")
        .in("course_id", courseIds)
        .eq("is_published", true)
        .order("created_at", { ascending: false })
    : { data: [] };

  const tests = (Array.isArray(testsData) ? testsData : []) as TestRow[];
  const testIds = tests.map((t) => t.id);

  const { data: attemptsData } = testIds.length
    ? await supabase
        .from("test_attempts")
        .select("test_id, score, passed, submitted_at, attempt_number")
        .eq("user_id", user.id)
        .in("test_id", testIds)
    : { data: [] };

  const attempts = (Array.isArray(attemptsData) ? attemptsData : []) as AttemptRow[];

  const attemptsByTest: Record<string, AttemptRow[]> = {};
  for (const a of attempts) {
    attemptsByTest[a.test_id] = attemptsByTest[a.test_id] || [];
    attemptsByTest[a.test_id].push(a);
  }

  const latestByTest: Record<string, AttemptRow | null> = {};
  for (const [tid, rows] of Object.entries(attemptsByTest)) {
    const sorted = [...rows].sort((a, b) => {
      const av = a.attempt_number ?? 0;
      const bv = b.attempt_number ?? 0;
      return bv - av;
    });
    latestByTest[tid] = sorted[0] ?? null;
  }

  const getStatusInfo = (row: { latest: AttemptRow | null; maxAttempts: number | null; passScore: number | null }) => {
    const latest = row.latest;
    if (!latest || !latest.submitted_at) {
      return {
        icon: <AlertCircle className="h-5 w-5 text-muted-foreground" />,
        label: "Not Started",
        class: "bg-gray-100 text-gray-800",
      };
    }
    if (latest.passed) {
      return { icon: <CheckCircle className="h-5 w-5 text-green-600" />, label: "Passed", class: "bg-green-100 text-green-800" };
    }
    return { icon: <XCircle className="h-5 w-5 text-red-600" />, label: "Failed", class: "bg-red-100 text-red-800" };
  };

  const totalTests = tests.length;
  const passedCount = tests.filter((t) => latestByTest[t.id]?.passed === true).length;
  const failedCount = tests.filter((t) => {
    const latest = latestByTest[t.id];
    return latest?.submitted_at && latest.passed === false;
  }).length;
  const pendingCount = totalTests - passedCount - failedCount;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ClipboardList className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Tests</h1>
          <p className="text-muted-foreground">View and take your course assessments</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center">
              <ClipboardList className="h-6 w-6 text-primary" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Tests</p>
              <p className="text-2xl font-bold text-foreground">{totalTests}</p>
            </div>
          </div>
        </div>
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-green-100 flex items-center justify-center">
              <CheckCircle className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Passed</p>
              <p className="text-2xl font-bold text-foreground">{passedCount}</p>
            </div>
          </div>
        </div>
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-red-100 flex items-center justify-center">
              <XCircle className="h-6 w-6 text-red-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Failed</p>
              <p className="text-2xl font-bold text-foreground">{failedCount}</p>
            </div>
          </div>
        </div>
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-gray-100 flex items-center justify-center">
              <AlertCircle className="h-6 w-6 text-gray-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Pending</p>
              <p className="text-2xl font-bold text-foreground">{pendingCount}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-card border rounded-lg shadow-sm overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Test</th>
              <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Course</th>
              <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Score</th>
              <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Status</th>
              <th className="text-right px-6 py-3 text-sm font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {tests.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-10 text-center text-muted-foreground">
                  No tests available yet.
                </td>
              </tr>
            ) : (
              tests.map((t) => {
                const course = courseMap.get(t.course_id);
                const courseLabel = (course?.title ?? "").trim() || t.course_id;
                const latest = latestByTest[t.id] ?? null;
                const statusInfo = getStatusInfo({ latest, maxAttempts: t.max_attempts, passScore: t.pass_score });
                const attemptsUsed = (attemptsByTest[t.id] || []).length;
                const maxAttempts = typeof t.max_attempts === "number" ? t.max_attempts : null;

                return (
                  <tr key={t.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                          {statusInfo.icon}
                        </div>
                        <div>
                          <p className="font-medium text-foreground">{(t.title ?? "").trim() || "Assessment"}</p>
                          <p className="text-xs text-muted-foreground">
                            Attempts: {attemptsUsed}{maxAttempts ? ` / ${maxAttempts}` : ""}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">{courseLabel}</td>
                    <td className="px-6 py-4">
                      {typeof latest?.score === "number" && latest.submitted_at ? (
                        <div>
                          <p className={`text-lg font-bold ${latest.passed ? "text-green-600" : "text-red-600"}`}>
                            {latest.score}%
                          </p>
                          <p className="text-xs text-muted-foreground">Passing: {t.pass_score ?? 0}%</p>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusInfo.class}`}>
                        {statusInfo.label}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Button size="sm" className="gap-2" asChild>
                        <Link href={`/org/${orgSlug}/tests/${t.id}/take`}>
                          <Play className="h-4 w-4" />
                          Take Test
                        </Link>
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

