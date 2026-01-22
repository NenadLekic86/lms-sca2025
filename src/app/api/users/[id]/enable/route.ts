import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import type { Role } from "@/types";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

type UserRole = Role;

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
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: targetUserId } = await params;

    const { user: caller, error: authError } = await getServerUser();
    if (authError || !caller) {
      await logApiEvent({
        request,
        caller: null,
        outcome: "error",
        status: 401,
        code: "UNAUTHORIZED",
        publicMessage: "Unauthorized",
        internalMessage: typeof authError === "string" ? authError : "No authenticated user",
      });
      return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
    }

    if (targetUserId === caller.id) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 400,
        code: "VALIDATION_ERROR",
        publicMessage: "You can’t enable your own account.",
      });
      return apiError("VALIDATION_ERROR", "You can’t enable your own account.", { status: 400 });
    }

    // NOTE: org admins usually cannot RLS-read other users in public.users, so we use the admin client here.
    const admin = createAdminSupabaseClient();
    const { data: target, error: targetError } = await admin
      .from("users")
      .select("id, role, organization_id")
      .eq("id", targetUserId)
      .single();

    if (targetError || !target) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 404,
        code: "NOT_FOUND",
        publicMessage: "User not found.",
      });
      return apiError("NOT_FOUND", "User not found.", { status: 404 });
    }

    const targetRole = target.role as UserRole;
    const targetOrgId = (target.organization_id as string | null) ?? null;
    const callerRole = caller.role as UserRole;
    const callerOrgId = (caller.organization_id as string | null) ?? null;

    // super_admin is protected
    if (targetRole === "super_admin") {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 403,
        code: "FORBIDDEN",
        publicMessage: "Forbidden",
        internalMessage: "attempted to enable super_admin",
      });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }

    // permission checks
    if (callerRole === "member") {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 403,
        code: "FORBIDDEN",
        publicMessage: "Forbidden",
        internalMessage: "member cannot enable users",
      });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }
    if (callerRole === "system_admin" || callerRole === "super_admin") {
      // ok
    } else if (callerRole === "organization_admin") {
      if (targetRole !== "member") {
        await logApiEvent({
          request,
          caller,
          outcome: "error",
          status: 403,
          code: "FORBIDDEN",
          publicMessage: "Forbidden",
          internalMessage: "org admin attempted to enable non-member",
        });
        return apiError("FORBIDDEN", "Forbidden", { status: 403 });
      }
      if (!callerOrgId || callerOrgId !== targetOrgId) {
        await logApiEvent({
          request,
          caller,
          outcome: "error",
          status: 403,
          code: "FORBIDDEN",
          publicMessage: "Forbidden",
          internalMessage: "org mismatch",
        });
        return apiError("FORBIDDEN", "Forbidden", { status: 403 });
      }
    } else {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 403,
        code: "FORBIDDEN",
        publicMessage: "Forbidden",
      });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }

    const { error: updateError } = await admin
      .from("users")
      // Manual enable: clear disabled_by_org so org-level disable/enable remains distinguishable
      .update({ is_active: true, disabled_by_org: false })
      .eq("id", targetUserId);

    if (updateError) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Failed to enable user.",
        internalMessage: updateError.message,
      });
      return apiError("INTERNAL", "Failed to enable user.", { status: 500 });
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

    await logApiEvent({
      request,
      caller,
      outcome: "success",
      status: 200,
      publicMessage: "User enabled.",
      details: { user_id: targetUserId },
    });

    return apiOk({ user_id: targetUserId }, { status: 200, message: "User enabled." });
  } catch (e) {
    console.error("PATCH /api/users/[id]/enable error:", e);
    const msg = e instanceof Error ? e.message : "Unknown error";
    try {
      const { user: caller } = await getServerUser();
      if (caller) {
        await logApiEvent({
          request,
          caller,
          outcome: "error",
          status: 500,
          code: "INTERNAL",
          publicMessage: "Internal server error.",
          internalMessage: msg,
        });
      }
    } catch {
      // ignore
    }
    return apiError("INTERNAL", "Internal server error.", { status: 500 });
  }
}


