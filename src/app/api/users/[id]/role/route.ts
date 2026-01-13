import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient, getServerUser } from '@/lib/supabase/server';
import { changeRoleSchema, validateSchema } from '@/lib/validations/schemas';

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
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // 2. Check if caller has permission (only super_admin and system_admin)
    if (!['super_admin', 'system_admin'].includes(caller.role)) {
      return NextResponse.json(
        { error: 'Forbidden: insufficient permissions' },
        { status: 403 }
      );
    }

    // 3. Parse and validate request body with zod
    const body = await request.json().catch(() => null);
    const validation = validateSchema(changeRoleSchema, body);
    
    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      );
    }

    const { role: newRole } = validation.data;

    // 4. Load target user to check if they're super_admin
    const supabase = await createServerSupabaseClient();

    const { data: targetUser, error: targetUserError } = await supabase
      .from('users')
      .select('id, role')
      .eq('id', targetUserId)
      .single();

    if (targetUserError || !targetUser) {
      return NextResponse.json(
        { error: 'Target user not found' },
        { status: 404 }
      );
    }

    if ((targetUser as { role?: string | null }).role === 'super_admin') {
      return NextResponse.json(
        { error: 'Forbidden: super_admin role cannot be changed' },
        { status: 403 }
      );
    }

    // 5. Prevent self-demotion (safety check)
    if (targetUserId === caller.id) {
      return NextResponse.json(
        { error: 'Cannot change your own role' },
        { status: 400 }
      );
    }

    // 6. Call the RPC to change role
    const { error: rpcError } = await supabase.rpc('change_user_role', {
      p_user_id: targetUserId,
      p_new_role: newRole,
    });

    if (rpcError) {
      console.error('RPC change_user_role error:', rpcError);
      return NextResponse.json(
        { error: rpcError.message || 'Failed to change user role' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      message: 'User role updated successfully',
      user_id: targetUserId,
      new_role: newRole,
    });

  } catch (error) {
    console.error('PATCH /api/users/[id]/role error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
