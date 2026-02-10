import { NextRequest } from "next/server";

import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import type { Role } from "@/types";

export const runtime = "nodejs";

type UserRole = Role;

function maskedAuditRequest(request: Request): Request {
  // Avoid storing the target user UUID in audit_logs metadata (no trace of deleted user identifiers).
  const url = new URL(request.url);
  const maskedUrl = `${url.origin}/api/users/:id/delete`;
  return new Request(maskedUrl, { method: request.method, headers: request.headers });
}

function placeholderEmail(userId: string) {
  return `deleted+${userId}@example.invalid`;
}

async function removeUserAvatars(admin: ReturnType<typeof createAdminSupabaseClient>, userId: string) {
  const bucket = "user-avatars";
  const prefix = `users/${userId}`;

  // Best-effort cleanup. Do not throw.
  try {
    const { data: objects, error: listError } = await admin.storage.from(bucket).list(prefix, { limit: 1000, offset: 0 });
    if (listError) return { removed: 0, error: listError.message };

    const names = (Array.isArray(objects) ? objects : [])
      .map((o) => (o && typeof o.name === "string" ? o.name : null))
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0);

    if (names.length === 0) return { removed: 0 };

    const paths = names.map((name) => `${prefix}/${name}`);
    const { error: removeError } = await admin.storage.from(bucket).remove(paths);
    if (removeError) return { removed: 0, error: removeError.message };

    return { removed: paths.length };
  } catch (e) {
    return { removed: 0, error: e instanceof Error ? e.message : "Failed to remove avatars" };
  }
}

/**
 * DELETE /api/users/[id]/delete
 *
 * Operational deletion:
 * - Tombstones + scrubs PII in public.users (deleted_at/by, placeholder email)
 * - Deletes reporting "fact rows" so the user disappears from reports/exports
 * - Anonymizes audit logs (removes target identity + metadata)
 * - Bans the Supabase Auth user and changes their auth email to the placeholder
 * - Revokes sessions (best-effort)
 * - Deletes avatar storage objects (best-effort)
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auditReq = maskedAuditRequest(request);
  const { id: targetUserId } = await params;

  const { user: caller, error: authError } = await getServerUser();
  if (authError || !caller) {
    await logApiEvent({
      request: auditReq,
      caller: null,
      outcome: "error",
      status: 401,
      code: "UNAUTHORIZED",
      publicMessage: "Unauthorized",
      internalMessage: typeof authError === "string" ? authError : "No authenticated user",
    });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  if (!targetUserId || typeof targetUserId !== "string") {
    await logApiEvent({
      request: auditReq,
      caller,
      outcome: "error",
      status: 400,
      code: "VALIDATION_ERROR",
      publicMessage: "Invalid user id.",
    });
    return apiError("VALIDATION_ERROR", "Invalid user id.", { status: 400 });
  }

  // Safety: prevent self-delete (avoid breaking current session mid-request).
  if (targetUserId === caller.id) {
    await logApiEvent({
      request: auditReq,
      caller,
      outcome: "error",
      status: 400,
      code: "VALIDATION_ERROR",
      publicMessage: "You can’t delete your own account.",
    });
    return apiError("VALIDATION_ERROR", "You can’t delete your own account.", { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Load target for permission checks (bypass RLS).
  const { data: target, error: targetError } = await admin
    .from("users")
    .select("id, role, organization_id, deleted_at")
    .eq("id", targetUserId)
    .single();

  if (targetError || !target) {
    await logApiEvent({ request: auditReq, caller, outcome: "error", status: 404, code: "NOT_FOUND", publicMessage: "User not found." });
    return apiError("NOT_FOUND", "User not found.", { status: 404 });
  }

  const targetRole = target.role as UserRole;
  const targetOrgId = (target.organization_id as string | null) ?? null;
  const callerRole = caller.role as UserRole;
  const callerOrgId = (caller.organization_id as string | null) ?? null;

  // Protected super_admin (unique index enforces single super_admin).
  if (targetRole === "super_admin") {
    await logApiEvent({
      request: auditReq,
      caller,
      outcome: "error",
      status: 403,
      code: "FORBIDDEN",
      publicMessage: "Forbidden",
      internalMessage: "attempted to delete super_admin",
    });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  // If already deleted, treat as idempotent success.
  if (target.deleted_at) {
    await logApiEvent({ request: auditReq, caller, outcome: "success", status: 200, publicMessage: "User already deleted." });
    return apiOk({ user_id: targetUserId }, { status: 200, message: "User already deleted." });
  }

  // Permission matrix
  if (callerRole === "member") {
    await logApiEvent({ request: auditReq, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  if (callerRole === "super_admin" || callerRole === "system_admin") {
    // allowed (except super_admin which we already blocked)
  } else if (callerRole === "organization_admin") {
    // Safety: org admins can delete ONLY members in their own org.
    if (targetRole !== "member") {
      await logApiEvent({
        request: auditReq,
        caller,
        outcome: "error",
        status: 403,
        code: "FORBIDDEN",
        publicMessage: "Forbidden",
        internalMessage: "org admin attempted to delete non-member",
      });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }
    if (!callerOrgId || callerOrgId !== targetOrgId) {
      await logApiEvent({
        request: auditReq,
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
    await logApiEvent({ request: auditReq, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  // Best-effort: insert an audit row that will be anonymized by the SQL function (no target identity retained).
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "operational_delete_user",
      entity: "users",
      entity_id: targetUserId,
      target_user_id: targetUserId,
      metadata: {},
    });
  } catch {
    // ignore
  }

  // Run the DB-side transactional delete/scrub.
  const { error: deleteError } = await admin.rpc("operational_delete_user", {
    p_target_user_id: targetUserId,
    p_deleted_by: caller.id,
  });

  if (deleteError) {
    await logApiEvent({
      request: auditReq,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to delete user.",
      internalMessage: deleteError.message,
    });
    return apiError("INTERNAL", "Failed to delete user.", { status: 500 });
  }

  // Auth: anonymize email, ban user, revoke sessions (best-effort).
  const nextEmail = placeholderEmail(targetUserId);
  try {
    await admin.auth.admin.updateUserById(targetUserId, { email: nextEmail });
  } catch {
    // ignore
  }
  try {
    // Ban for ~100 years (Supabase expects a duration string here).
    await admin.auth.admin.updateUserById(targetUserId, { ban_duration: "876000h" });
  } catch {
    // ignore
  }
  // Note: Admin sign-out requires a user's JWT. We rely on:
  // - public.users.is_active = false (proxy will force logout UX)
  // - auth ban (prevents re-login)

  // Storage: remove avatar objects (best-effort).
  const avatarCleanup = await removeUserAvatars(admin, targetUserId);

  await logApiEvent({
    request: auditReq,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "User deleted.",
    details: {
      avatar_removed: avatarCleanup.removed,
      avatar_error: avatarCleanup.error ?? null,
    },
  });

  return apiOk(
    { user_id: targetUserId },
    {
      status: 200,
      message: "User deleted.",
    }
  );
}

