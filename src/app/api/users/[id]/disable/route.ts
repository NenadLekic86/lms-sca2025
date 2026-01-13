import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabaseClient, getServerUser } from '@/lib/supabase/server';

type UserRole = "super_admin" | "system_admin" | "organization_admin" | "member";

/**
 * PATCH /api/users/[id]/disable
 * Disables a user (soft delete) by setting public.users.is_active = false
 * 
 * Permissions:
 * - super_admin: can disable any user EXCEPT super_admin
 * - system_admin: can disable any user EXCEPT super_admin
 * - organization_admin: can disable ONLY members in their own org
 * - member: not allowed
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
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // 2. Prevent self-disabling (safety check)
    if (targetUserId === caller.id) {
      return NextResponse.json(
        { error: 'Cannot disable your own account' },
        { status: 400 }
      );
    }

    // 3. Load target user for permission checks
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

    const targetRole = (target.role as UserRole);
    const targetOrgId = (target.organization_id as string | null) ?? null;
    const callerRole = (caller.role as UserRole);
    const callerOrgId = (caller.organization_id as string | null) ?? null;

    // super_admin is protected
    if (targetRole === "super_admin") {
      return NextResponse.json({ error: "Forbidden: cannot disable super_admin" }, { status: 403 });
    }

    // 4. Permission checks
    if (callerRole === "member") {
      return NextResponse.json({ error: "Forbidden: insufficient permissions" }, { status: 403 });
    }
    if (callerRole === "system_admin" || callerRole === "super_admin") {
      // ok
    } else if (callerRole === "organization_admin") {
      if (targetRole !== "member") {
        return NextResponse.json({ error: "Forbidden: org admins can only disable members" }, { status: 403 });
      }
      if (!callerOrgId || callerOrgId !== targetOrgId) {
        return NextResponse.json({ error: "Forbidden: org mismatch" }, { status: 403 });
      }
    } else {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 5. Update is_active using admin client (server-side only)
    const { error: updateError } = await admin
      .from("users")
      // Manual disable: mark NOT disabled_by_org (org disable flow sets disabled_by_org=true)
      .update({ is_active: false, disabled_by_org: false })
      .eq("id", targetUserId);

    if (updateError) {
      return NextResponse.json(
        { error: updateError.message || "Failed to disable user" },
        { status: 500 }
      );
    }

    // Best-effort audit log
    try {
      await admin.from("audit_logs").insert({
        actor_user_id: caller.id,
        actor_email: caller.email,
        actor_role: caller.role,
        action: "disable_user",
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

    return NextResponse.json({
      message: 'User disabled successfully',
      user_id: targetUserId,
    });

  } catch (error) {
    console.error('PATCH /api/users/[id]/disable error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

