import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { env } from "@/env.mjs";

type UserRole = "super_admin" | "system_admin" | "organization_admin" | "member";

function canSendPasswordSetupLink(
  callerRole: UserRole,
  callerOrgId: string | null,
  targetRole: UserRole,
  targetOrgId: string | null
) {
  if (callerRole === "member") return { ok: false, reason: "Forbidden: insufficient permissions" };
  if (targetRole === "super_admin") return { ok: false, reason: "Forbidden: cannot send setup link for super_admin" };

  if (callerRole === "super_admin") return { ok: true as const };
  if (callerRole === "system_admin") {
    if (targetRole !== "organization_admin") return { ok: false, reason: "Forbidden: system admins can only manage organization_admin" };
    return { ok: true as const };
  }
  if (callerRole === "organization_admin") {
    if (targetRole !== "member") return { ok: false, reason: "Forbidden: org admins can only manage members" };
    if (!callerOrgId || callerOrgId !== targetOrgId) return { ok: false, reason: "Forbidden: org mismatch" };
    return { ok: true as const };
  }

  return { ok: false, reason: "Forbidden" };
}

/**
 * POST /api/users/[id]/password-setup
 * Sends a "password setup" email (Supabase password recovery) to an existing user.
 *
 * This is intentionally NOT an invite. Use it when:
 * - the user exists but never set a password yet, or
 * - the user forgot their password.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: targetUserId } = await params;

    const { user: caller, error: authError } = await getServerUser();
    if (authError || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = await createServerSupabaseClient();
    const { data: target, error: targetError } = await supabase
      .from("users")
      .select("id, email, role, organization_id")
      .eq("id", targetUserId)
      .single();

    if (targetError || !target) {
      return NextResponse.json({ error: "Target user not found" }, { status: 404 });
    }

    const targetRole = target.role as UserRole;
    const targetOrgId = (target.organization_id as string | null) ?? null;

    const allowed = canSendPasswordSetupLink(
      caller.role as UserRole,
      caller.organization_id ?? null,
      targetRole,
      targetOrgId
    );
    if (!allowed.ok) return NextResponse.json({ error: allowed.reason }, { status: 403 });

    const admin = createAdminSupabaseClient();
    const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

    // Send a recovery link. This works for existing users (and is safe to call even if the auth user doesn't exist).
    const { error: sendError } = await admin.auth.resetPasswordForEmail(target.email, {
      redirectTo: `${appUrl}/reset-password`,
    });

    if (sendError) {
      return NextResponse.json({ error: sendError.message || "Failed to send password setup link" }, { status: 500 });
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
    console.error("POST /api/users/[id]/password-setup error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}


