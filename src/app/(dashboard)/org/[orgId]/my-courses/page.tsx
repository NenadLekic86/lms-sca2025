import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BookOpen, Play, CheckCircle, Circle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";

export const fetchCache = "force-no-store";

type CourseRow = {
  id: string;
  title: string | null;
  excerpt: string | null;
  is_published: boolean | null;
};

export default async function StudentMyCoursesPage({ params }: { params: Promise<{ orgId: string }> }) {
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
    .select("course_id, status")
    .eq("user_id", user.id)
    .eq("organization_id", orgId)
    .eq("status", "active");

  const courseIds = (Array.isArray(enrollments) ? enrollments : [])
    .map((r: { course_id?: string | null }) => r.course_id)
    .filter((v): v is string => typeof v === "string");

  const { data: coursesData } =
    courseIds.length > 0
      ? await supabase
          .from("courses")
          .select("id, title, excerpt, is_published")
          .in("id", courseIds)
          .order("created_at", { ascending: false })
      : { data: [] };

  const courses = (Array.isArray(coursesData) ? coursesData : []) as CourseRow[];

  const { data: resourcesData } = courseIds.length
    ? await supabase.from("course_resources").select("id, course_id").in("course_id", courseIds)
    : { data: [] };
  const { data: videosData } = courseIds.length
    ? await supabase.from("course_videos").select("id, course_id").in("course_id", courseIds)
    : { data: [] };
  const { data: progressData } = courseIds.length
    ? await supabase
        .from("course_content_progress")
        .select("course_id, item_type, item_id, completed_at")
        .in("course_id", courseIds)
        .eq("user_id", user.id)
    : { data: [] };

  const totalByCourse: Record<string, number> = {};
  for (const r of (Array.isArray(resourcesData) ? resourcesData : []) as Array<{ course_id?: string | null }>) {
    if (!r.course_id) continue;
    totalByCourse[r.course_id] = (totalByCourse[r.course_id] || 0) + 1;
  }
  for (const v of (Array.isArray(videosData) ? videosData : []) as Array<{ course_id?: string | null }>) {
    if (!v.course_id) continue;
    totalByCourse[v.course_id] = (totalByCourse[v.course_id] || 0) + 1;
  }

  const completedByCourse: Record<string, number> = {};
  for (const p of (Array.isArray(progressData) ? progressData : []) as Array<{ course_id?: string | null; completed_at?: string | null }>) {
    if (!p.course_id) continue;
    if (!p.completed_at) continue;
    completedByCourse[p.course_id] = (completedByCourse[p.course_id] || 0) + 1;
  }

  const derivedStatus = (courseId: string) => {
    const total = totalByCourse[courseId] || 0;
    const done = completedByCourse[courseId] || 0;
    if (total > 0 && done >= total) return "completed";
    if (done > 0) return "in_progress";
    return "not_started";
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle className="h-5 w-5 text-green-600" />;
      case "in_progress":
        return <Play className="h-5 w-5 text-blue-600" />;
      default:
        return <Circle className="h-5 w-5 text-muted-foreground" />;
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "completed":
        return { label: "Completed", class: "bg-green-100 text-green-800" };
      case "in_progress":
        return { label: "In Progress", class: "bg-blue-100 text-blue-800" };
      default:
        return { label: "Not Started", class: "bg-gray-100 text-gray-800" };
    }
  };

  const inProgressCount = courses.filter((c) => derivedStatus(c.id) === "in_progress").length;
  const completedCount = courses.filter((c) => derivedStatus(c.id) === "completed").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BookOpen className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Courses</h1>
          <p className="text-muted-foreground">Track your learning progress</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-blue-100 flex items-center justify-center">
              <Play className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">In Progress</p>
              <p className="text-2xl font-bold text-foreground">{inProgressCount}</p>
            </div>
          </div>
        </div>
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-green-100 flex items-center justify-center">
              <CheckCircle className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Completed</p>
              <p className="text-2xl font-bold text-foreground">{completedCount}</p>
            </div>
          </div>
        </div>
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-muted flex items-center justify-center">
              <BookOpen className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total</p>
              <p className="text-2xl font-bold text-foreground">{courses.length}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {courses.length === 0 ? (
          <div className="col-span-full rounded-lg border bg-card p-10 text-center text-muted-foreground">
            You are not enrolled in any courses yet.
          </div>
        ) : (
          courses.map((course) => {
            const status = derivedStatus(course.id);
            const statusInfo = getStatusLabel(status);
            const total = totalByCourse[course.id] || 0;
            const done = completedByCourse[course.id] || 0;
            const progress = total > 0 ? Math.round((done / total) * 100) : 0;
            const title = (course.title ?? "").trim() || "(untitled)";
            const excerpt = (course.excerpt ?? "").trim();

            return (
              <div key={course.id} className="bg-card border rounded-lg p-6 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex items-start gap-4">
                  <div className="h-14 w-14 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    {getStatusIcon(status)}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-foreground">{title}</h3>
                        <p className="text-sm text-muted-foreground mt-1">{excerpt || "No excerpt yet."}</p>
                      </div>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusInfo.class}`}>
                        {statusInfo.label}
                      </span>
                    </div>

                    <div className="mt-4">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-muted-foreground">Progress</span>
                        <span className="font-medium text-foreground">
                          {done}/{total} • {progress}%
                        </span>
                      </div>
                      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${progress === 100 ? "bg-green-500" : "bg-primary"}`} style={{ width: `${progress}%` }} />
                      </div>
                    </div>

                    <div className="mt-4">
                      <Button className="w-full gap-2" asChild>
                        <Link href={`/org/${orgSlug}/courses/${course.id}/learn`}>
                          <Play className="h-4 w-4" />
                          {status === "completed" ? "Review Course" : status === "in_progress" ? "Continue Learning" : "Start Course"}
                        </Link>
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

