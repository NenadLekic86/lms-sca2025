import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from '@/lib/supabase/server';

type RpcUserRow = {
  id: string;
  organization_id?: string | null;
  // RPCs may or may not include is_active; we merge it in below.
  is_active?: boolean | null;
  full_name?: string | null;
  onboarding_status?: string | null;
  invited_at?: string | null;
  activated_at?: string | null;
  [key: string]: unknown;
};

/**
 * GET /api/users
 * Returns users based on caller's role:
 * - super_admin/system_admin: all users (via get_all_users RPC)
 * - organization_admin: org users only (via get_org_users RPC)
 * - member: not allowed
 */
export async function GET(request: NextRequest) {
  try {
    const requestedOrgId = new URL(request.url).searchParams.get('organization_id');

    // 1. Verify caller is authenticated and get their role
    const { user: caller, error: authError } = await getServerUser();
    
    if (authError || !caller) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // 2. Check if caller has permission to view users
    const allowedRoles = ['super_admin', 'system_admin', 'organization_admin'];
    if (!allowedRoles.includes(caller.role)) {
      return NextResponse.json(
        { error: 'Forbidden: insufficient permissions' },
        { status: 403 }
      );
    }

    // 3. Call appropriate RPC based on role
    const supabase = await createServerSupabaseClient();
    
    let result;
    if (caller.role === 'super_admin' || caller.role === 'system_admin') {
      // Super/system admins get all users
      result = await supabase.rpc('get_all_users');
    } else {
      // Org admins get only their org users
      result = await supabase.rpc('get_org_users');
    }

    if (result.error) {
      console.error('RPC error:', result.error);
      return NextResponse.json(
        { error: 'Failed to fetch users' },
        { status: 500 }
      );
    }

    // Optional server-side org filter (useful for /org/[orgId]/users even for super/system admins)
    const users = Array.isArray(result.data) ? (result.data as RpcUserRow[]) : [];
    const filteredUsers =
      requestedOrgId && (caller.role === 'super_admin' || caller.role === 'system_admin')
        ? users.filter((u) => u.organization_id === requestedOrgId)
        : users;

    // Security/UX hardening: system_admin must not see super_admin user at all.
    const visibleToCaller =
      caller.role === "system_admin"
        ? filteredUsers.filter((u) => u.role !== "super_admin")
        : filteredUsers;

    // Ensure is_active + full_name + onboarding_status are present in response (RPC may not include them)
    const ids = visibleToCaller
      .map((u) => (typeof u.id === 'string' ? u.id : null))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (ids.length > 0) {
      // Use admin client for enrichment to bypass RLS safely.
      // The endpoint already enforces caller role and the user set is already filtered by RPC.
      const admin = createAdminSupabaseClient();
      const { data: extra, error: extraError } = await admin
        .from('users')
        .select('id, is_active, full_name, onboarding_status, invited_at, activated_at')
        .in('id', ids);

      if (!extraError && Array.isArray(extra)) {
        const map = new Map<
          string,
          {
            is_active: boolean | null;
            full_name: string | null;
            onboarding_status: string | null;
            invited_at: string | null;
            activated_at: string | null;
          }
        >();
        extra.forEach((r) => {
          const id = (r as { id?: unknown }).id;
          const isActive = (r as { is_active?: unknown }).is_active;
          const fullName = (r as { full_name?: unknown }).full_name;
          const onboardingStatus = (r as { onboarding_status?: unknown }).onboarding_status;
          const invitedAt = (r as { invited_at?: unknown }).invited_at;
          const activatedAt = (r as { activated_at?: unknown }).activated_at;
          if (typeof id === 'string') {
            map.set(id, {
              is_active: typeof isActive === 'boolean' ? isActive : null,
              full_name: typeof fullName === 'string' ? fullName : null,
              onboarding_status: typeof onboardingStatus === 'string' ? onboardingStatus : null,
              invited_at: typeof invitedAt === 'string' ? invitedAt : null,
              activated_at: typeof activatedAt === 'string' ? activatedAt : null,
            });
          }
        });
        visibleToCaller.forEach((u) => {
          const v = map.get(u.id);
          u.is_active = v?.is_active ?? null;
          u.full_name = v?.full_name ?? null;
          u.onboarding_status = v?.onboarding_status ?? null;
          u.invited_at = v?.invited_at ?? null;
          u.activated_at = v?.activated_at ?? null;
        });
      }
    }

    return NextResponse.json({ 
      users: visibleToCaller,
      caller_role: caller.role 
    });

  } catch (error) {
    console.error('GET /api/users error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

