import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

type UserRole = "super_admin" | "system_admin" | "organization_admin" | "member";

/**
 * PATCH /api/users/[id]/enable
 * Re-enables a user account by setting public.users.is_active = true
 *
 * Permissions (mirrors disable intent):
 * - super_admin: can enable any user EXCEPT super_admin
 * - system_admin: can enable any user EXCEPT super_admin
 * - organization_admin: can enable ONLY members in their own org
 * - member: not allowed
 */
export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: targetUserId } = await params;

    const { user: caller, error: authError } = await getServerUser();
    if (authError || !caller) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (targetUserId === caller.id) {
      return NextResponse.json({ error: "Cannot enable your own account" }, { status: 400 });
    }

    // NOTE: org admins usually cannot RLS-read other users in public.users, so we use the admin client here.
    const admin = createAdminSupabaseClient();
    const { data: target, error: targetError } = await admin
      .from("users")
      .select("id, role, organization_id")
      .eq("id", targetUserId)
      .single();

    if (targetError || !target) {
      return NextResponse.json({ error: "Target user not found" }, { status: 404 });
    }

    const targetRole = target.role as UserRole;
    const targetOrgId = (target.organization_id as string | null) ?? null;
    const callerRole = caller.role as UserRole;
    const callerOrgId = (caller.organization_id as string | null) ?? null;

    // super_admin is protected
    if (targetRole === "super_admin") {
      return NextResponse.json({ error: "Forbidden: cannot enable super_admin" }, { status: 403 });
    }

    // permission checks
    if (callerRole === "member") {
      return NextResponse.json({ error: "Forbidden: insufficient permissions" }, { status: 403 });
    }
    if (callerRole === "system_admin" || callerRole === "super_admin") {
      // ok
    } else if (callerRole === "organization_admin") {
      if (targetRole !== "member") {
        return NextResponse.json({ error: "Forbidden: org admins can only enable members" }, { status: 403 });
      }
      if (!callerOrgId || callerOrgId !== targetOrgId) {
        return NextResponse.json({ error: "Forbidden: org mismatch" }, { status: 403 });
      }
    } else {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { error: updateError } = await admin
      .from("users")
      // Manual enable: clear disabled_by_org so org-level disable/enable remains distinguishable
      .update({ is_active: true, disabled_by_org: false })
      .eq("id", targetUserId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message || "Failed to enable user" }, { status: 500 });
    }

    // Best-effort audit log
    try {
      await admin.from("audit_logs").insert({
        actor_user_id: caller.id,
        actor_email: caller.email,
        actor_role: caller.role,
        action: "enable_user",
        entity: "users",
        entity_id: targetUserId,
        target_user_id: targetUserId,
        metadata: {
          target_role: targetRole,
          organization_id: targetOrgId,
        },
      });
    } catch {
      // ignore
    }

    return NextResponse.json({ message: "User enabled successfully", user_id: targetUserId });
  } catch (e) {
    console.error("PATCH /api/users/[id]/enable error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}


