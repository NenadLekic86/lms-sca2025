import OrgSettingsClient from "./OrgSettingsClient";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";
import { notFound, redirect } from "next/navigation";

export default async function SettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
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

  const admin = createAdminSupabaseClient();
  const { data: orgRow } = await admin
    .from("organizations")
    .select("id, name, slug, logo_url")
    .eq("id", orgId)
    .single();

  const orgName = (orgRow as { name?: unknown } | null)?.name;
  const orgSlug = (orgRow as { slug?: unknown } | null)?.slug;
  const orgLogoUrl = (orgRow as { logo_url?: unknown } | null)?.logo_url;

  const orgLabel =
    typeof orgName === "string" && orgName.trim().length > 0
      ? orgName.trim()
      : typeof orgSlug === "string" && orgSlug.trim().length > 0
        ? orgSlug.trim()
        : orgSlugResolved || orgId;

  return (
    <OrgSettingsClient
      orgId={orgId}
      orgLabel={orgLabel}
      initialLogoUrl={typeof orgLogoUrl === "string" && orgLogoUrl.trim().length > 0 ? orgLogoUrl : null}
    />
  );
}

