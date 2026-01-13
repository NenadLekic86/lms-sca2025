import type { Role } from '@/types';

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
  message: string;
  user: ApiUser;
}

export interface ChangeRoleResponse {
  message: string;
  user_id: string;
  new_role: Role;
}

export interface DisableUserResponse {
  message: string;
  user_id: string;
}

export interface EnableUserResponse {
  message: string;
  user_id: string;
}

export interface ResendInviteResponse {
  message: string;
}

export interface PasswordSetupLinkResponse {
  message: string;
}

export interface AssignOrganizationResponse {
  message: string;
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
    const response = await fetch(url);
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to fetch users');
    }
    
    return response.json();
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
  ): Promise<InviteUserResponse> {
    const response = await fetch('/api/users/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        email, 
        full_name: fullName ?? null,
        role, 
        organization_id: organizationId 
      }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to invite user');
    }
    
    return response.json();
  },

  /**
   * Change a user's role (via RPC)
   * @param userId - Target user ID
   * @param newRole - New role to assign
   */
  async changeUserRole(
    userId: string, 
    newRole: Role
  ): Promise<ChangeRoleResponse> {
    const response = await fetch(`/api/users/${userId}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to change user role');
    }
    
    return response.json();
  },

  /**
   * Disable a user (soft delete via RPC)
   * @param userId - Target user ID
   */
  async disableUser(userId: string): Promise<DisableUserResponse> {
    const response = await fetch(`/api/users/${userId}/disable`, {
      method: 'PATCH',
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to disable user');
    }
    
    return response.json();
  },

  /**
   * Enable a user (reactivate)
   */
  async enableUser(userId: string): Promise<EnableUserResponse> {
    const response = await fetch(`/api/users/${userId}/enable`, {
      method: "PATCH",
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Failed to enable user");
    }

    return response.json();
  },

  /**
   * Resend an invite email to a user.
   */
  async resendInvite(userId: string): Promise<ResendInviteResponse> {
    const response = await fetch(`/api/users/${userId}/resend-invite`, {
      method: "POST",
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Failed to resend invite");
    }

    return response.json();
  },

  /**
   * Send a password setup link (recovery email) to a user.
   */
  async sendPasswordSetupLink(userId: string): Promise<PasswordSetupLinkResponse> {
    const response = await fetch(`/api/users/${userId}/password-setup`, {
      method: "POST",
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Failed to send password setup link");
    }

    return response.json();
  },

  /**
   * Assign/reassign an organization_admin to an organization.
   */
  async assignOrganization(userId: string, organizationId: string): Promise<AssignOrganizationResponse> {
    const response = await fetch(`/api/users/${userId}/organization`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id: organizationId }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Failed to assign organization");
    }

    return response.json();
  },
};
