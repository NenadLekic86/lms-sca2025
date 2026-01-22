import type { Role } from '@/types';
import { fetchJson } from "@/lib/api";

type ApiResult<T> = T & { message?: string };

// Types for API responses
export interface ApiUser {
  id: string;
  full_name?: string | null;
  email: string;
  role: Role;
  // Present in get_all_users(); may be omitted by get_org_users()
  organization_id?: string | null;
  created_at?: string;
  is_active?: boolean | null;
  onboarding_status?: "pending" | "active" | null;
  invited_at?: string | null;
  activated_at?: string | null;
}

export interface GetUsersResponse {
  users: ApiUser[];
  caller_role: Role;
}

export interface InviteUserResponse {
  user: ApiUser;
}

export interface ChangeRoleResponse {
  user_id: string;
  new_role: Role;
}

export interface DisableUserResponse {
  user_id: string;
}

export interface EnableUserResponse {
  user_id: string;
}

export interface ResendInviteResponse {
  ok: true;
}

export interface PasswordSetupLinkResponse {
  ok: true;
}

export interface AssignOrganizationResponse {
  user_id: string;
  organization_id: string;
}

/**
 * Users API client - calls server-side API routes
 * Server routes handle RPC calls and auth admin operations
 */
export const usersApi = {
  /**
   * Get users list (via RPC based on caller's role)
   * - super_admin/system_admin: all users
   * - organization_admin: org users only
   */
  async getUsers(organizationId?: string): Promise<GetUsersResponse> {
    const url = organizationId ? `/api/users?organization_id=${encodeURIComponent(organizationId)}` : '/api/users';
    const { data } = await fetchJson<GetUsersResponse>(url);
    return data;
  },

  /**
   * Invite a new user (creates auth user + profile)
   * @param email - User's email address
   * @param role - Role to assign
   * @param organizationId - Organization ID (required for org-scoped users)
   */
  async inviteUser(
    email: string, 
    role: Role, 
    organizationId?: string | null,
    fullName?: string | null
  ): Promise<ApiResult<InviteUserResponse>> {
    const { data, message } = await fetchJson<InviteUserResponse>('/api/users/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        email, 
        full_name: fullName ?? null,
        role, 
        organization_id: organizationId 
      }),
    });
    return { ...data, message };
  },

  /**
   * Change a user's role (via RPC)
   * @param userId - Target user ID
   * @param newRole - New role to assign
   */
  async changeUserRole(
    userId: string, 
    newRole: Role
  ): Promise<ApiResult<ChangeRoleResponse>> {
    const { data, message } = await fetchJson<ChangeRoleResponse>(`/api/users/${userId}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    });
    return { ...data, message };
  },

  /**
   * Disable a user (soft delete via RPC)
   * @param userId - Target user ID
   */
  async disableUser(userId: string): Promise<ApiResult<DisableUserResponse>> {
    const { data, message } = await fetchJson<DisableUserResponse>(`/api/users/${userId}/disable`, { method: "PATCH" });
    return { ...data, message };
  },

  /**
   * Enable a user (reactivate)
   */
  async enableUser(userId: string): Promise<ApiResult<EnableUserResponse>> {
    const { data, message } = await fetchJson<EnableUserResponse>(`/api/users/${userId}/enable`, { method: "PATCH" });
    return { ...data, message };
  },

  /**
   * Resend an invite email to a user.
   */
  async resendInvite(userId: string): Promise<ApiResult<ResendInviteResponse>> {
    const { data, message } = await fetchJson<ResendInviteResponse>(`/api/users/${userId}/resend-invite`, { method: "POST" });
    return { ...data, message };
  },

  /**
   * Send a password setup link (recovery email) to a user.
   */
  async sendPasswordSetupLink(userId: string): Promise<ApiResult<PasswordSetupLinkResponse>> {
    const { data, message } = await fetchJson<PasswordSetupLinkResponse>(`/api/users/${userId}/password-setup`, { method: "POST" });
    return { ...data, message };
  },

  /**
   * Assign/reassign an organization_admin to an organization.
   */
  async assignOrganization(userId: string, organizationId: string): Promise<ApiResult<AssignOrganizationResponse>> {
    const { data, message } = await fetchJson<AssignOrganizationResponse>(`/api/users/${userId}/organization`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id: organizationId }),
    });
    return { ...data, message };
  },
};
