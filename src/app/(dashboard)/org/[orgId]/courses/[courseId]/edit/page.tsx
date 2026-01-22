import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import type { CourseEditorCourse } from "@/features/courses/components/CourseEditorForm";
import { CourseEditorForm } from "@/features/courses/components/CourseEditorForm";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";

export const fetchCache = "force-no-store";

export default async function OrgCourseEditPage({
  params,
}: {
  params: Promise<{ orgId: string; courseId: string }>;
}) {
  const { user, error } = await getServerUser();
  if (error || !user) redirect("/");

  const { orgId: orgKey, courseId } = await params;
  const resolved = await resolveOrgKey(orgKey);
  const org = resolved.org;
  if (!org) {
    if (user.role === "organization_admin" || user.role === "member") redirect("/unauthorized");
    notFound();
  }

  const orgId = org.id; // UUID (DB/API)
  const orgSlug = org.slug; // canonical slug (links)

  // Org edit is org-admin only (super/system edit via their own routes)
  if (user.role !== "organization_admin") redirect("/unauthorized");
  if (!user.organization_id || user.organization_id !== orgId) redirect("/unauthorized");

  const supabase = await createServerSupabaseClient();
  const { data: courseRow, error: courseError } = await supabase
    .from("courses")
    .select("id, title, description, excerpt, is_published, visibility_scope, cover_image_url, organization_id")
    .eq("id", courseId)
    .single();

  if (courseError || !courseRow) {
    redirect(`/org/${orgSlug}/courses`);
  }

  // Extra defensive check: org admins can only edit org-owned courses
  if ((courseRow as CourseEditorCourse).organization_id !== orgId) {
    redirect("/unauthorized");
  }

  return (
    <CourseEditorForm
      mode="edit"
      actorRole={user.role}
      orgId={orgSlug}
      backHref={`/org/${orgSlug}/courses`}
      course={courseRow as CourseEditorCourse}
    />
  );
}

