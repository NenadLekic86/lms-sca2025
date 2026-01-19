import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { env } from "@/env.mjs";

type UserRole = "super_admin" | "system_admin" | "organization_admin" | "member";

function canResendInvite(callerRole: UserRole, callerOrgId: string | null, targetRole: UserRole, targetOrgId: string | null) {
  if (callerRole === "member") return { ok: false, reason: "Forbidden: insufficient permissions" };
  if (targetRole === "super_admin") return { ok: false, reason: "Forbidden: cannot resend invite for super_admin" };

  if (callerRole === "super_admin") return { ok: true as const };
  if (callerRole === "system_admin") {
    if (targetRole !== "organization_admin") return { ok: false, reason: "Forbidden: system admins can only invite organization_admin" };
    return { ok: true as const };
  }
  if (callerRole === "organization_admin") {
    if (targetRole !== "member") return { ok: false, reason: "Forbidden: org admins can only invite members" };
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
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Anti-enumeration: fail fast for obviously disallowed callers (and don't leak if target exists).
    if ((caller.role as UserRole) === "member") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
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
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const targetRole = target.role as UserRole;
    const targetOrgId = (target.organization_id as string | null) ?? null;

    const allowed = canResendInvite(caller.role as UserRole, caller.organization_id ?? null, targetRole, targetOrgId);
    if (!allowed.ok) {
      // Anti-enumeration: don't reveal whether the target user exists or is simply not allowed.
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

    const { error: sendError } = await admin.auth.resetPasswordForEmail(target.email, {
      redirectTo: `${appUrl}/reset-password`,
    });

    if (sendError) {
      return NextResponse.json({ error: sendError.message || "Failed to send setup link" }, { status: 500 });
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

    return NextResponse.json({ message: "Password setup link sent." }, { status: 200 });
  } catch (e) {
    console.error("POST /api/users/[id]/resend-invite error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}


