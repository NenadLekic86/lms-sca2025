import { NextRequest } from 'next/server';
import { createAdminSupabaseClient, getServerUser } from '@/lib/supabase/server';
import { inviteUserSchema, validateSchema } from '@/lib/validations/schemas';
import { env } from '@/env.mjs';
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

/**
 * POST /api/users/invite
 * Invites a new user via Supabase Auth Admin API + creates profile row
 * 
 * Permissions:
 * - super_admin: can invite system_admin / organization_admin / member (NEVER super_admin)
 * - system_admin: can invite ONLY organization_admin (NEVER super_admin)
 * - organization_admin: can only invite members to their own org
 * - member: not allowed
 */
export async function POST(request: NextRequest) {
  try {
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

    // 2. Parse and validate request body with zod
    const body = await request.json().catch(() => null);
    const validation = validateSchema(inviteUserSchema, body);
    
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

    const { email, role, organization_id, full_name } = validation.data;

    // 3. Check permissions based on caller's role
    
    // Members cannot invite anyone
    if (caller.role === 'member') {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 403,
        code: "FORBIDDEN",
        publicMessage: "Forbidden",
        internalMessage: "members cannot invite users",
      });
      return apiError("FORBIDDEN", "You don’t have permission to invite users.", { status: 403 });
    }

    // No one can invite/create super_admin users (only one exists)
    if (role === 'super_admin') {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 403,
        code: "FORBIDDEN",
        publicMessage: "Forbidden",
        internalMessage: "attempted to invite super_admin",
      });
      return apiError("FORBIDDEN", "You can’t invite a super_admin user.", { status: 403 });
    }

    // Determine the final organization_id
    let finalOrgId = organization_id;

    // Organization admins can only invite members to their own org
    if (caller.role === 'organization_admin') {
      if (role !== 'member') {
        await logApiEvent({
          request,
          caller,
          outcome: "error",
          status: 403,
          code: "FORBIDDEN",
          publicMessage: "Forbidden",
          internalMessage: "org admin attempted to invite non-member",
        });
        return apiError("FORBIDDEN", "Organization admins can only invite members.", { status: 403 });
      }
      // Force the org_id to be caller's org (cannot invite to other orgs)
      finalOrgId = caller.organization_id;
    }

    // System admins can invite ONLY organization_admin
    if (caller.role === 'system_admin' && role !== 'organization_admin') {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 403,
        code: "FORBIDDEN",
        publicMessage: "Forbidden",
        internalMessage: "system_admin attempted to invite disallowed role",
      });
      return apiError("FORBIDDEN", "System admins can only invite organization admins.", { status: 403 });
    }

    // Super admins can invite system_admin / organization_admin / member (handled by the super_admin check above)

    // 4. Use Admin API (service role) to invite the user
    const adminClient = createAdminSupabaseClient();
    
    const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
    const { data: authData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
      email,
      {
        // Optional: customize the redirect URL after user accepts invite
        redirectTo: `${appUrl}/reset-password`,
      }
    );

    if (inviteError) {
      console.error('Auth invite error:', inviteError);
      
      // Handle duplicate email
      if (inviteError.message?.includes('already registered')) {
        await logApiEvent({
          request,
          caller,
          outcome: "error",
          status: 409,
          code: "CONFLICT",
          publicMessage: "User with this email already exists.",
          internalMessage: inviteError.message,
          details: { email },
        });
        return apiError("CONFLICT", "User with this email already exists.", { status: 409 });
      }
      
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Failed to invite user.",
        internalMessage: inviteError.message,
      });
      return apiError("INTERNAL", "Failed to invite user.", { status: 500 });
    }

    if (!authData.user) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Failed to create user.",
        internalMessage: "inviteUserByEmail returned no user",
      });
      return apiError("INTERNAL", "Failed to create user.", { status: 500 });
    }

    // 5. Insert profile row into public.users
    const { error: profileError } = await adminClient
      .from('users')
      .insert({
        id: authData.user.id,
        email: email,
        role: role,
        organization_id: finalOrgId || null,
        full_name: full_name,
        is_active: true,
        onboarding_status: "pending",
        invited_at: new Date().toISOString(),
        activated_at: null,
      });

    if (profileError) {
      console.error('Profile insert error:', profileError);
      
      // Rollback: delete the auth user if profile insert failed
      await adminClient.auth.admin.deleteUser(authData.user.id);
      
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Failed to create user profile.",
        internalMessage: profileError.message,
      });
      return apiError("INTERNAL", "Failed to create user profile.", { status: 500 });
    }

    // 6. Audit log (best-effort; never block invite success on logging issues)
    try {
      await adminClient.from('audit_logs').insert({
        actor_user_id: caller.id,
        actor_email: caller.email,
        actor_role: caller.role,
        action: 'invite_user',
        entity: 'users',
        entity_id: authData.user.id,
        target_user_id: authData.user.id,
        metadata: {
          invited_email: email,
          invited_role: role,
          organization_id: finalOrgId ?? null,
          full_name: full_name,
        },
      });
    } catch (auditError) {
      console.error('Audit log insert failed (invite_user):', auditError);
    }

    // 7. Success - return the new user info
    await logApiEvent({
      request,
      caller,
      outcome: "success",
      status: 201,
      publicMessage: "User invited successfully.",
      details: { invited_role: role, organization_id: finalOrgId ?? null },
    });

    return apiOk(
      {
        user: {
          id: authData.user.id,
          email: email,
          role: role,
          organization_id: finalOrgId || null,
          full_name: full_name,
        },
      },
      { status: 201, message: "User invited successfully." }
    );

  } catch (error) {
    console.error('POST /api/users/invite error:', error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    // Best-effort: attempt to attribute to caller if available.
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
