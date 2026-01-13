import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/supabase/server";
import { CourseEditorForm } from "@/features/courses/components/CourseEditorForm";

export default async function AdminCourseNewPage() {
  const { user, error } = await getServerUser();
  if (error || !user) redirect("/");
  if (user.role !== "super_admin") redirect("/unauthorized");

  return (
    <CourseEditorForm
      mode="create"
      actorRole={user.role}
      backHref="/admin/courses"
    />
  );
}

