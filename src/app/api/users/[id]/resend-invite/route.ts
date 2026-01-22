import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { env } from "@/env.mjs";
import type { Role } from "@/types";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

type UserRole = Role;

function canResendInvite(callerRole: UserRole, callerOrgId: string | null, targetRole: UserRole, targetOrgId: string | null) {
  if (callerRole === "member") return { ok: false, reason: "Forbidden: insufficient permissions" };
  // super_admin can send setup link to anyone (including super_admin).
  if (callerRole === "super_admin") return { ok: true as const };

  // Everyone else cannot target super_admin.
  if (targetRole === "super_admin") return { ok: false, reason: "Forbidden: cannot resend invite for super_admin" };

  if (callerRole === "system_admin") {
    if (targetRole === "system_admin" || targetRole === "organization_admin" || targetRole === "member") return { ok: true as const };
    return { ok: false, reason: "Forbidden: invalid target role" };
  }
  if (callerRole === "organization_admin") {
    if (targetRole !== "member" && targetRole !== "organization_admin") {
      return { ok: false, reason: "Forbidden: org admins can only manage members and org admins" };
    }
    if (!callerOrgId || callerOrgId !== targetOrgId) return { ok: false, reason: "Forbidden: org mismatch" };
    return { ok: true as const };
  }

  return { ok: false, reason: "Forbidden" };
}

/**
 * POST /api/users/[id]/resend-invite
 *
 * Backward-compatible alias for "Send password setup link".
 * (We keep the endpoint so older UI calls don't break.)
 */
export async function POST(
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

    // Anti-enumeration: fail fast for obviously disallowed callers (and don't leak if target exists).
    if ((caller.role as UserRole) === "member") {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 404,
        code: "NOT_FOUND",
        publicMessage: "Not found",
        internalMessage: "member attempted resend-invite",
      });
      return apiError("NOT_FOUND", "Not found", { status: 404 });
    }

    // NOTE: use admin client to bypass RLS safely (route enforces permissions below).
    const admin = createAdminSupabaseClient();
    const { data: target, error: targetError } = await admin
      .from("users")
      .select("id, email, role, organization_id")
      .eq("id", targetUserId)
      .single();

    if (targetError || !target) {
      // Anti-enumeration: don't reveal whether the target user exists.
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 404,
        code: "NOT_FOUND",
        publicMessage: "Not found",
      });
      return apiError("NOT_FOUND", "Not found", { status: 404 });
    }

    const targetRole = target.role as UserRole;
    const targetOrgId = (target.organization_id as string | null) ?? null;

    const allowed = canResendInvite(caller.role as UserRole, caller.organization_id ?? null, targetRole, targetOrgId);
    if (!allowed.ok) {
      // Anti-enumeration: don't reveal whether the target user exists or is simply not allowed.
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 404,
        code: "NOT_FOUND",
        publicMessage: "Not found",
        internalMessage: allowed.reason,
      });
      return apiError("NOT_FOUND", "Not found", { status: 404 });
    }

    const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

    const { error: sendError } = await admin.auth.resetPasswordForEmail(target.email, {
      redirectTo: `${appUrl}/reset-password`,
    });

    if (sendError) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Failed to send password setup link.",
        internalMessage: sendError.message,
      });
      return apiError("INTERNAL", "Failed to send password setup link.", { status: 500 });
    }

    // Best-effort audit log
    try {
      await admin.from("audit_logs").insert({
        actor_user_id: caller.id,
        actor_email: caller.email,
        actor_role: caller.role,
        action: "send_password_setup_link",
        entity: "users",
        entity_id: targetUserId,
        target_user_id: targetUserId,
        metadata: {
          target_email: target.email,
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
      publicMessage: "Password setup link sent.",
      details: { user_id: targetUserId },
    });

    return apiOk({ ok: true }, { status: 200, message: "Password setup link sent." });
  } catch (e) {
    console.error("POST /api/users/[id]/resend-invite error:", e);
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


