import { notFound, redirect } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";

type OrgRow = { id: string; name?: string | null; slug?: string | null };
type CourseRow = { id: string; title?: string | null; name?: string | null };
type TestRow = {
  id: string;
  title?: string | null;
  course_id?: string | null;
  organization_id?: string | null;
  is_published?: boolean | null;
  max_attempts?: number | null;
  pass_score?: number | null;
  created_at?: string | null;
};
type AttemptRow = { test_id: string };

async function safeQueryRows<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  try {
    const { data, error } = await query;
    return { rows: (Array.isArray(data) ? (data as T[]) : []), error: error?.message ?? null };
  } catch (e) {
    return { rows: [] as T[], error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export default async function TestsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { user, error } = await getServerUser();
  if (error || !user) return null;

  const { orgId: orgKey } = await params;
  const resolved = await resolveOrgKey(orgKey);
  const org = resolved.org;
  if (!org) {
    if (user.role === "organization_admin" || user.role === "member") redirect("/unauthorized");
    notFound();
  }

  const orgId = org.id; // UUID (DB/API)
  const orgSlugResolved = org.slug; // canonical slug (links)

  // Members should use /my-tests
  if (user.role === "member") {
    redirect(`/org/${orgSlugResolved}/my-tests`);
  }

  const supabase = await createServerSupabaseClient();

  const [{ data: orgRow }, { data: testsData, error: testsError }, { data: coursesData }, attemptsRes] = await Promise.all([
    supabase.from("organizations").select("id, name, slug").eq("id", orgId).single(),
    supabase
      .from("tests")
      .select("id, title, course_id, organization_id, is_published, max_attempts, pass_score, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("courses").select("id, title, name").eq("organization_id", orgId),
    safeQueryRows<AttemptRow>(supabase.from("test_attempts").select("test_id").eq("organization_id", orgId)),
  ]);

  const tests = (Array.isArray(testsData) ? testsData : []) as TestRow[];
  const courses = (Array.isArray(coursesData) ? coursesData : []) as CourseRow[];

  const courseMap = new Map<string, CourseRow>();
  courses.forEach((c) => courseMap.set(c.id, c));

  const attemptsByTest: Record<string, number> = {};
  for (const a of attemptsRes.rows) {
    attemptsByTest[a.test_id] = (attemptsByTest[a.test_id] || 0) + 1;
  }

  const orgName = (orgRow as OrgRow | null)?.name ?? null;
  const orgSlug = (orgRow as OrgRow | null)?.slug ?? null;
  const orgLabel = (orgName && orgName.trim().length > 0) ? orgName : (orgSlug && orgSlug.trim().length > 0 ? orgSlug : orgSlugResolved || orgId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ClipboardList className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Tests</h1>
            <p className="text-muted-foreground">Organization: {orgLabel}</p>
          </div>
        </div>
      </div>

      {testsError ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Failed to load tests: {testsError.message}
        </div>
      ) : null}
      {attemptsRes.error ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Attempt counts not available: {attemptsRes.error}
        </div>
      ) : null}

      <div className="bg-card border rounded-lg shadow-sm overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Title</th>
              <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Course</th>
              <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Attempts</th>
              <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Pass score</th>
              <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {tests.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-10 text-center text-muted-foreground">
                  No tests found.
                </td>
              </tr>
            ) : (
              tests.map((t) => {
                const title = t.title ?? "(untitled)";
                const course = t.course_id ? courseMap.get(t.course_id) : null;
                const courseLabel = course ? (course.title ?? course.name ?? course.id) : (t.course_id ?? "—");
                const attempts = attemptsByTest[t.id] || 0;
                const maxAttempts = typeof t.max_attempts === "number" ? t.max_attempts : null;
                const pass = typeof t.pass_score === "number" ? t.pass_score : null;
                const status = t.is_published ? "published" : "draft";

                return (
                  <tr key={t.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-6 py-4 font-medium">{title}</td>
                    <td className="px-6 py-4 text-muted-foreground">{courseLabel}</td>
                    <td className="px-6 py-4">{maxAttempts ? `${attempts} / ${maxAttempts}` : attempts}</td>
                    <td className="px-6 py-4">{pass ?? "—"}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        status === "published" ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"
                      }`}>
                        {status}
                      </span>
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

