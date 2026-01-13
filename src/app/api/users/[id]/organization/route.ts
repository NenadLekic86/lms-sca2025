import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { assignOrganizationSchema, validateSchema } from "@/lib/validations/schemas";

/**
 * PATCH /api/users/[id]/organization
 * Assign/reassign an org-scoped user (organization_admin or member) to an organization.
 *
 * Permissions:
 * - super_admin/system_admin: allowed
 * - organization_admin/member: forbidden
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: userId } = await params;
    const { user: caller, error: authError } = await getServerUser();
    if (authError || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!["super_admin", "system_admin"].includes(caller.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!userId || typeof userId !== "string") {
      return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    const validation = validateSchema(assignOrganizationSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { organization_id } = validation.data;

    const admin = createAdminSupabaseClient();

    const isMissingColumnError = (msg: string) =>
      /column/i.test(msg) && (/does not exist/i.test(msg) || /schema cache/i.test(msg));

    // Ensure target user exists and is org-scoped (and never super_admin)
    // We also load is_active + disabled_by_org (if present) so we can preserve manual disables during reassignment.
    let target: Record<string, unknown> | null = null;
    let hasDisabledByOrgColumn = true;

    const targetAttempt = await admin
      .from("users")
      .select("id, email, role, organization_id, is_active, disabled_by_org")
      .eq("id", userId)
      .single();

    if (targetAttempt.error) {
      const msg = targetAttempt.error.message ?? "";
      const missingDisabledByOrg = /disabled_by_org/i.test(msg) && isMissingColumnError(msg);
      if (!missingDisabledByOrg) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }

      hasDisabledByOrgColumn = false;
      const fallbackTarget = await admin
        .from("users")
        .select("id, email, role, organization_id, is_active")
        .eq("id", userId)
        .single();

      if (fallbackTarget.error || !fallbackTarget.data) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }

      target = fallbackTarget.data as unknown as Record<string, unknown>;
    } else {
      target = (targetAttempt.data ?? null) as unknown as Record<string, unknown> | null;
    }

    if (!target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const targetRole = (target as { role?: unknown }).role;
    if (targetRole === "super_admin") {
      return NextResponse.json({ error: "Forbidden: super_admin cannot be modified" }, { status: 403 });
    }
    if (targetRole !== "organization_admin" && targetRole !== "member") {
      return NextResponse.json({ error: "Forbidden: only organization_admin/member can be assigned to an organization" }, { status: 403 });
    }

    // Ensure org exists
    const { data: org, error: orgError } = await admin
      .from("organizations")
      .select("id, name, slug, is_active")
      .eq("id", organization_id)
      .single();

    if (orgError || !org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    const orgIsActive = (org as { is_active?: unknown }).is_active !== false;

    // Preserve manual disables during reassignment:
    // - If the user is disabled manually (is_active=false and disabled_by_org is not true), do NOT change is_active.
    // - If the user is disabled due to org (disabled_by_org=true), moving to an active org should enable them.
    // - Moving an active user to an inactive org disables them with disabled_by_org=true (if the column exists).
    const targetIsActiveRaw = (target as { is_active?: unknown }).is_active;
    const targetIsDisabled = targetIsActiveRaw === false;
    const targetDisabledByOrgRaw = hasDisabledByOrgColumn ? (target as { disabled_by_org?: unknown }).disabled_by_org : null;
    const targetDisabledByOrg = hasDisabledByOrgColumn ? targetDisabledByOrgRaw === true : null;

    const isManuallyDisabled = targetIsDisabled && (hasDisabledByOrgColumn ? targetDisabledByOrg !== true : true);
    const isOrgDisabled = hasDisabledByOrgColumn ? targetIsDisabled && targetDisabledByOrg === true : false;

    const updatePayload: Record<string, unknown> = { organization_id };

    if (isManuallyDisabled) {
      // Preserve: do not change is_active or disabled_by_org.
    } else if (!orgIsActive) {
      updatePayload.is_active = false;
      if (hasDisabledByOrgColumn) updatePayload.disabled_by_org = true;
    } else {
      // org is active
      if (isOrgDisabled) updatePayload.is_active = true;
      if (hasDisabledByOrgColumn) updatePayload.disabled_by_org = false;
    }

    const updateAttempt = await admin
      .from("users")
      .update(updatePayload)
      .eq("id", userId);

    if (updateAttempt.error) {
      const msg = updateAttempt.error.message ?? "";
      const missingColumn =
        /disabled_by_org/i.test(msg) && (/column/i.test(msg) || /does not exist/i.test(msg) || /schema cache/i.test(msg));

      if (!missingColumn) {
        return NextResponse.json({ error: msg || "Failed to assign organization" }, { status: 500 });
      }

      // Fallback if disabled_by_org doesn't exist (preserve manual disables by never forcing is_active=true)
      const fallbackPayload: Record<string, unknown> = { organization_id };
      if (!isManuallyDisabled && !orgIsActive) fallbackPayload.is_active = false;
      // If org is active, do not force-enable here (preserve disabled users when disabled_by_org isn't available)

      const fallback = await admin
        .from("users")
        .update(fallbackPayload)
        .eq("id", userId);

      if (fallback.error) {
        return NextResponse.json({ error: fallback.error.message }, { status: 500 });
      }
    }

    // Best-effort audit log
    try {
      await admin.from("audit_logs").insert({
        actor_user_id: caller.id,
        actor_email: caller.email,
        actor_role: caller.role,
        action: "assign_user_organization",
        entity: "users",
        entity_id: userId,
        target_user_id: userId,
        metadata: {
          organization_id,
          organization_name: (org as { name?: unknown }).name ?? null,
          organization_slug: (org as { slug?: unknown }).slug ?? null,
          organization_is_active: orgIsActive,
          previous_organization_id: (target as { organization_id?: unknown }).organization_id ?? null,
        },
      });
    } catch {
      // ignore
    }

    return NextResponse.json({ message: "Organization assigned", user_id: userId, organization_id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Internal server error" }, { status: 500 });
  }
}


