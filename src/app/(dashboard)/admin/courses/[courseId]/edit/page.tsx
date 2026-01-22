import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/supabase/server";

export const fetchCache = "force-no-store";

export default async function AdminCourseEditPage() {
  const { user, error } = await getServerUser();
  if (error || !user) redirect("/");
  // Courses module is disabled for super_admin/system_admin by design.
  redirect("/unauthorized");
}

