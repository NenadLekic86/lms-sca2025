import { notFound, redirect } from "next/navigation";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";
import { CourseEditorV2Form } from "@/features/courses/components/CourseEditorV2Form";

export default async function OrgCourseNewV2Page({ params }: { params: Promise<{ orgId: string }> }) {
  const { user, error } = await getServerUser();
  if (error || !user) redirect("/");

  const { orgId: orgKey } = await params;
  const resolved = await resolveOrgKey(orgKey);
  const org = resolved.org;
  if (!org) {
    if (user.role === "organization_admin" || user.role === "member") redirect("/unauthorized");
    notFound();
  }

  const orgId = org.id;
  const orgSlug = org.slug;
  if (user.role !== "organization_admin") redirect("/unauthorized");
  if (!user.organization_id || user.organization_id !== orgId) redirect("/unauthorized");

  const admin = createAdminSupabaseClient();
  const { data: membersData } = await admin
    .from("users")
    .select("id, full_name, email")
    .eq("organization_id", orgId)
    .eq("role", "member")
    .neq("is_active", false)
    .order("full_name", { ascending: true });

  const memberOptions = (Array.isArray(membersData) ? membersData : [])
    .map((m) => {
      const fullName = typeof (m as { full_name?: unknown }).full_name === "string" && (m as { full_name: string }).full_name.trim().length > 0 ? (m as { full_name: string }).full_name.trim() : null;
      const email = typeof (m as { email?: unknown }).email === "string" && (m as { email: string }).email.trim().length > 0 ? (m as { email: string }).email.trim() : null;
      const id = String((m as { id: string }).id);
      return {
        id,
        label: fullName ?? email ?? id,
      };
    })
    .filter((m): m is { id: string; label: string } => typeof m.id === "string" && typeof m.label === "string");

  return (
    <CourseEditorV2Form
      mode="create"
      orgSlug={orgSlug}
      backHref={`/org/${orgSlug}/courses`}
      initialCourse={null}
      initialTopics={[]}
      memberOptions={memberOptions}
    />
  );
}

