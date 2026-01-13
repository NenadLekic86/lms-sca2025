import { notFound, redirect } from "next/navigation";
import { getServerUser } from "@/lib/supabase/server";
import { CourseEditorForm } from "@/features/courses/components/CourseEditorForm";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";

export default async function OrgCourseNewPage({ params }: { params: Promise<{ orgId: string }> }) {
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

  // Org course creation is org-admin only (super/system use their own /admin or /system pages).
  if (user.role !== "organization_admin") redirect("/unauthorized");
  if (!user.organization_id || user.organization_id !== orgId) redirect("/unauthorized");

  return (
    <CourseEditorForm
      mode="create"
      actorRole={user.role}
      orgId={orgSlug}
      backHref={`/org/${orgSlug}/courses`}
    />
  );
}

