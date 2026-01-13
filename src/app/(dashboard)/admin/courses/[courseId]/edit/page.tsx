import { redirect } from "next/navigation";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import type { CourseEditorCourse } from "@/features/courses/components/CourseEditorForm";
import { CourseEditorForm } from "@/features/courses/components/CourseEditorForm";

export const fetchCache = "force-no-store";

export default async function AdminCourseEditPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  const { user, error } = await getServerUser();
  if (error || !user) redirect("/");
  if (user.role !== "super_admin") redirect("/unauthorized");

  const supabase = await createServerSupabaseClient();

  const { data: courseRow, error: courseError } = await supabase
    .from("courses")
    .select("id, title, description, excerpt, is_published, visibility_scope, cover_image_url, organization_id")
    .eq("id", courseId)
    .single();

  if (courseError || !courseRow) {
    redirect("/admin/courses");
  }

  const { data: orgLinks } = await supabase
    .from("course_organizations")
    .select("organization_id")
    .eq("course_id", courseId);

  const orgIds = (Array.isArray(orgLinks) ? orgLinks : [])
    .map((r: { organization_id?: string | null }) => r.organization_id)
    .filter((v): v is string => typeof v === "string");

  return (
    <CourseEditorForm
      mode="edit"
      actorRole={user.role}
      backHref="/admin/courses"
      course={courseRow as CourseEditorCourse}
      initialOrganizationIds={orgIds}
    />
  );
}

