import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/supabase/server";
import { CourseEditorForm } from "@/features/courses/components/CourseEditorForm";

export default async function SystemCourseNewPage() {
  const { user, error } = await getServerUser();
  if (error || !user) redirect("/");
  if (!["super_admin", "system_admin"].includes(user.role)) redirect("/unauthorized");

  return (
    <CourseEditorForm
      mode="create"
      actorRole={user.role}
      backHref="/system/courses"
    />
  );
}

