import { NextRequest } from 'next/server';
import { createAdminSupabaseClient, getServerUser } from '@/lib/supabase/server';
import { changeRoleSchema, validateSchema } from '@/lib/validations/schemas';
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

/**
 * PATCH /api/users/[id]/role
 * Changes a user's role via change_user_role RPC
 * 
 * Permissions:
 * - super_admin: can change any role
 * - system_admin: can change any role EXCEPT to super_admin
 * - others: not allowed
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: targetUserId } = await params;

    // 1. Verify caller is authenticated and get their role
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

    // 2. Check if caller has permission (only super_admin and system_admin)
    if (!['super_admin', 'system_admin'].includes(caller.role)) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 403,
        code: "FORBIDDEN",
        publicMessage: "Forbidden",
        internalMessage: "insufficient permissions to change role",
      });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }

    // 3. Parse request body
    const body = await request.json().catch(() => null);

    // 3.25 Safety: if system_admin attempts to assign super_admin, return 403 (even if schema changes later).
    // Note: current changeRoleSchema already rejects super_admin for everyone.
    if (caller.role === "system_admin" && body && typeof body === "object" && (body as { role?: unknown }).role === "super_admin") {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 403,
        code: "FORBIDDEN",
        publicMessage: "Forbidden",
        internalMessage: "system_admin attempted to assign super_admin",
      });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }

    // 3.5 Validate request body with zod
    const validation = validateSchema(changeRoleSchema, body);
    
    if (!validation.success) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 400,
        code: "VALIDATION_ERROR",
        publicMessage: validation.error,
      });
      return apiError("VALIDATION_ERROR", validation.error, { status: 400 });
    }

    const { role: newRole } = validation.data;

    // 4. Load target user to check if they're super_admin
    // NOTE: use admin client to bypass RLS safely (route already enforces caller permissions).
    const admin = createAdminSupabaseClient();
    const { data: targetUser, error: targetUserError } = await admin
      .from('users')
      .select('id, role')
      .eq('id', targetUserId)
      .single();

    if (targetUserError || !targetUser) {
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

    if ((targetUser as { role?: string | null }).role === 'super_admin') {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 403,
        code: "FORBIDDEN",
        publicMessage: "Forbidden",
        internalMessage: "attempted to change super_admin role",
      });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }

    // 5. Prevent self-demotion (safety check)
    if (targetUserId === caller.id) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 400,
        code: "VALIDATION_ERROR",
        publicMessage: "You can’t change your own role.",
      });
      return apiError("VALIDATION_ERROR", "You can’t change your own role.", { status: 400 });
    }

    // 6. Call the RPC to change role
    // Use admin client so the RPC is not blocked by RLS policies.
    const { error: rpcError } = await admin.rpc('change_user_role', {
      p_user_id: targetUserId,
      p_new_role: newRole,
    });

    if (rpcError) {
      console.error('RPC change_user_role error:', rpcError);
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Failed to change user role.",
        internalMessage: rpcError.message,
      });
      return apiError("INTERNAL", "Failed to change user role.", { status: 500 });
    }

    await logApiEvent({
      request,
      caller,
      outcome: "success",
      status: 200,
      publicMessage: "User role updated.",
      details: { user_id: targetUserId, new_role: newRole },
    });

    return apiOk(
      {
        user_id: targetUserId,
        new_role: newRole,
      },
      { status: 200, message: "User role updated." }
    );

  } catch (error) {
    console.error('PATCH /api/users/[id]/role error:', error);
    const msg = error instanceof Error ? error.message : "Unknown error";
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
