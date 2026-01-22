import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/supabase/server";

export default async function AdminCourseDetailPage() {
  const { user, error } = await getServerUser();
  if (error || !user) redirect("/");
  // Courses module is disabled for super_admin/system_admin by design.
  redirect("/unauthorized");
}

