import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

/**
 * PATCH /api/organizations/[orgId]/disable
 * Disables an organization by setting public.organizations.is_active = false.
 *
 * Also cascade-disables all users in that organization (so they cannot log in).
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

    // 1) Disable org
    const { error: updateOrgError } = await admin
      .from("organizations")
      .update({ is_active: false })
      .eq("id", orgId);

    if (updateOrgError) {
      return NextResponse.json({ error: updateOrgError.message || "Failed to disable organization" }, { status: 500 });
    }

    // 2) Cascade-disable users in org (best-effort but we do return error if this fails)
    // IMPORTANT: preserve manually-disabled users.
    // Only users who were active (is_active true or null) get disabled_by_org=true.
    // This ensures org re-enable only restores users that were disabled due to org disable.
    const cascadeWithReason = await admin
      .from("users")
      .update({ is_active: false, disabled_by_org: true } as unknown as Record<string, unknown>)
      .eq("organization_id", orgId)
      .or("is_active.is.null,is_active.eq.true");

    if (cascadeWithReason.error) {
      const msg = cascadeWithReason.error.message ?? "";
      const missingColumn =
        /disabled_by_org/i.test(msg) && (/column/i.test(msg) || /does not exist/i.test(msg) || /schema cache/i.test(msg));

      if (missingColumn) {
        const cascadeFallback = await admin
          .from("users")
          .update({ is_active: false })
          .eq("organization_id", orgId)
          .or("is_active.is.null,is_active.eq.true");

        if (cascadeFallback.error) {
          return NextResponse.json({ error: cascadeFallback.error.message || "Failed to disable org users" }, { status: 500 });
        }
      } else {
        return NextResponse.json({ error: msg || "Failed to disable org users" }, { status: 500 });
      }
    }

    // Best-effort audit log
    try {
      await admin.from("audit_logs").insert({
        actor_user_id: caller.id,
        actor_email: caller.email,
        actor_role: caller.role,
        action: "disable_organization",
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

    return NextResponse.json({ message: "Organization disabled", organization_id: orgId });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Internal server error" }, { status: 500 });
  }
}


