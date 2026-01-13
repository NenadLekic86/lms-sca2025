import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

/**
 * PATCH /api/organizations/[orgId]/enable
 * Enables an organization by setting public.organizations.is_active = true.
 *
 * Also re-enables users who were disabled because the org was disabled
 * (preferred: disabled_by_org=true). If that column doesn't exist, we fall back
 * to enabling all users in the org.
 *
 * Permissions:
 * - super_admin, system_admin: allowed
 * - others: forbidden
 */
export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId } = await params;

    const { user: caller, error } = await getServerUser();
    if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!["super_admin", "system_admin"].includes(caller.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const admin = createAdminSupabaseClient();

    // Ensure org exists
    const { data: org, error: orgError } = await admin
      .from("organizations")
      .select("id, is_active")
      .eq("id", orgId)
      .single();

    if (orgError || !org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    // 1) Enable org
    const { error: updateOrgError } = await admin
      .from("organizations")
      .update({ is_active: true })
      .eq("id", orgId);

    if (updateOrgError) {
      return NextResponse.json({ error: updateOrgError.message || "Failed to enable organization" }, { status: 500 });
    }

    // 2) Re-enable users (best-effort)
    // Preferred: only those disabled_by_org=true
    const enableWithReason = await admin
      .from("users")
      .update({ is_active: true, disabled_by_org: false } as unknown as Record<string, unknown>)
      .eq("organization_id", orgId)
      .eq("disabled_by_org", true);

    if (enableWithReason.error) {
      const msg = enableWithReason.error.message ?? "";
      const missingColumn =
        /disabled_by_org/i.test(msg) && (/column/i.test(msg) || /does not exist/i.test(msg) || /schema cache/i.test(msg));

      if (missingColumn) {
        // Fallback: enable all users in this org (may also enable manually-disabled users)
        const enableFallback = await admin
          .from("users")
          .update({ is_active: true })
          .eq("organization_id", orgId);

        if (enableFallback.error) {
          return NextResponse.json({ error: enableFallback.error.message || "Failed to enable org users" }, { status: 500 });
        }
      } else {
        return NextResponse.json({ error: msg || "Failed to enable org users" }, { status: 500 });
      }
    }

    // Best-effort audit log
    try {
      await admin.from("audit_logs").insert({
        actor_user_id: caller.id,
        actor_email: caller.email,
        actor_role: caller.role,
        action: "enable_organization",
        entity: "organizations",
        entity_id: orgId,
        metadata: {
          organization_id: orgId,
          previous_is_active: (org as { is_active?: unknown }).is_active ?? null,
        },
      });
    } catch {
      // ignore
    }

    return NextResponse.json({ message: "Organization enabled", organization_id: orgId });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Internal server error" }, { status: 500 });
  }
}


