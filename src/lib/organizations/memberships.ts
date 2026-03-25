import { createAdminSupabaseClient } from "@/lib/supabase/server";
import type { Role } from "@/types";

export type OrgScopedRole = Extract<Role, "organization_admin" | "member">;

type MembershipRow = {
  user_id?: string | null;
  organization_id?: string | null;
  role?: string | null;
  is_active?: boolean | null;
  created_at?: string | null;
};

type OrganizationRow = {
  id: string;
  name?: string | null;
  slug?: string | null;
};

export type UserOrganizationMembership = {
  userId: string;
  organizationId: string;
  role: OrgScopedRole | null;
  isActive: boolean;
  createdAt: string | null;
  organizationName: string | null;
  organizationSlug: string | null;
};

function normalizeRole(role: string | null | undefined): OrgScopedRole | null {
  return role === "organization_admin" || role === "member" ? role : null;
}

export async function getUserOrganizationMemberships(
  userId: string,
  options?: { roles?: OrgScopedRole[]; activeOnly?: boolean }
): Promise<{ memberships: UserOrganizationMembership[]; error: string | null }> {
  const admin = createAdminSupabaseClient();
  let query = admin
    .from("organization_memberships")
    .select("user_id, organization_id, role, is_active, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (options?.activeOnly !== false) {
    query = query.eq("is_active", true);
  }
  if (options?.roles?.length) {
    query = query.in("role", options.roles);
  }

  const { data, error } = await query;
  if (error) {
    return { memberships: [], error: error.message };
  }

  const membershipRows = (Array.isArray(data) ? data : []) as MembershipRow[];
  const orgIds = Array.from(
    new Set(
      membershipRows
        .map((row) => (typeof row.organization_id === "string" ? row.organization_id : null))
        .filter((value): value is string => Boolean(value))
    )
  );

  const orgMap = new Map<string, OrganizationRow>();
  if (orgIds.length > 0) {
    const { data: orgsData, error: orgsError } = await admin
      .from("organizations")
      .select("id, name, slug")
      .in("id", orgIds);

    if (orgsError) {
      return { memberships: [], error: orgsError.message };
    }

    for (const row of (Array.isArray(orgsData) ? orgsData : []) as OrganizationRow[]) {
      orgMap.set(row.id, row);
    }
  }

  const memberships = membershipRows
    .map((row) => {
      const organizationId = typeof row.organization_id === "string" ? row.organization_id : null;
      const userIdValue = typeof row.user_id === "string" ? row.user_id : null;
      if (!organizationId || !userIdValue) return null;

      const org = orgMap.get(organizationId);
      return {
        userId: userIdValue,
        organizationId,
        role: normalizeRole(row.role),
        isActive: row.is_active !== false,
        createdAt: typeof row.created_at === "string" ? row.created_at : null,
        organizationName:
          typeof org?.name === "string" && org.name.trim().length > 0 ? org.name.trim() : null,
        organizationSlug:
          typeof org?.slug === "string" && org.slug.trim().length > 0 ? org.slug.trim() : null,
      };
    })
    .filter((value): value is UserOrganizationMembership => Boolean(value));

  return { memberships, error: null };
}

export async function hasActiveOrganizationMembership(
  userId: string,
  organizationId: string,
  roles?: OrgScopedRole[]
): Promise<{ hasMembership: boolean; error: string | null }> {
  const admin = createAdminSupabaseClient();
  let query = admin
    .from("organization_memberships")
    .select("user_id", { head: true, count: "exact" })
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .eq("is_active", true);

  if (roles?.length) {
    query = query.in("role", roles);
  }

  const { count, error } = await query;
  if (error) {
    return { hasMembership: false, error: error.message };
  }

  return { hasMembership: (count ?? 0) > 0, error: null };
}

export async function getActiveOrganizationMemberIds(
  organizationId: string,
  roles: OrgScopedRole[] = ["organization_admin", "member"]
): Promise<{ userIds: string[]; error: string | null }> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from("organization_memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .in("role", roles);

  if (error) {
    return { userIds: [], error: error.message };
  }

  const userIds = Array.from(
    new Set(
      (Array.isArray(data) ? data : [])
        .map((row) => (typeof (row as { user_id?: unknown }).user_id === "string" ? (row as { user_id: string }).user_id : null))
        .filter((value): value is string => Boolean(value))
    )
  );

  return { userIds, error: null };
}
