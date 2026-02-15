'use client'

import { useState, useEffect, useCallback } from 'react';
import { usersApi, type ApiUser } from '../api/users.api';
import type { Role } from '@/types';

export const useUsers = (organizationId?: string) => {
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [callerRole, setCallerRole] = useState<Role | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await usersApi.getUsers(organizationId);
      setUsers(data.users);
      setCallerRole(data.caller_role);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  /**
   * Invite a new user
   */
  const inviteUser = async (email: string, role: Role, organizationId?: string | null, fullName?: string | null) => {
    const result = await usersApi.inviteUser(email, role, organizationId, fullName);
    // Refetch to get updated list
    await fetchUsers();
    return result;
  };

  /**
   * Change a user's role
   */
  const changeUserRole = async (userId: string, newRole: Role) => {
    const result = await usersApi.changeUserRole(userId, newRole);
    // Update local state
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
    return result;
  };

  /**
   * Disable a user (soft delete)
   */
  const disableUser = async (userId: string) => {
    const result = await usersApi.disableUser(userId);
    // Update local state (keep row visible for re-enable)
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, is_active: false } : u)));
    return result;
  };

  /**
   * Enable a user (reactivate)
   */
  const enableUser = async (userId: string) => {
    const result = await usersApi.enableUser(userId);
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, is_active: true } : u)));
    return result;
  };

  /**
   * Operational delete a user (tombstone + scrub + remove from reports/exports)
   */
  const deleteUser = async (userId: string) => {
    const result = await usersApi.deleteUser(userId);
    // Deleted users should disappear from the list (RPC excludes deleted_at users).
    setUsers((prev) => prev.filter((u) => u.id !== userId));
    return result;
  };

  /**
   * Resend an invite email to a user
   */
  const resendInvite = async (userId: string) => {
    return usersApi.resendInvite(userId);
  };

  /**
   * Assign/reassign an organization_admin to an organization
   */
  const assignOrganization = async (userId: string, organizationId: string) => {
    const result = await usersApi.assignOrganization(userId, organizationId);
    // Refetch so status (is_active) stays correct when moving users between active/inactive orgs.
    await fetchUsers();
    return result;
  };

  /**
   * Bulk assign org-scoped users to an organization.
   * We call the existing single-user endpoint for each user, then refetch once at the end.
   */
  const bulkAssignOrganization = async (userIds: string[], organizationId: string) => {
    const failures: Array<{ userId: string; error: string }> = [];

    for (const userId of userIds) {
      try {
        await usersApi.assignOrganization(userId, organizationId);
      } catch (e) {
        failures.push({
          userId,
          error: e instanceof Error ? e.message : "Failed to assign organization",
        });
      }
    }

    await fetchUsers();

    return {
      successCount: Math.max(0, userIds.length - failures.length),
      failureCount: failures.length,
      failures,
    };
  };

  /**
   * Send password setup link to a user
   */
  const sendPasswordSetupLink = async (userId: string) => {
    return usersApi.sendPasswordSetupLink(userId);
  };

  /**
   * Fetch org-admin assignable courses list.
   */
  const getAssignableCourses = useCallback(async () => {
    return usersApi.getAssignableCourses();
  }, []);

  /**
   * Fetch course assignment IDs for one user.
   */
  const getUserCourseAssignments = useCallback(async (userId: string) => {
    return usersApi.getUserCourseAssignments(userId);
  }, []);

  /**
   * Replace course assignments for one user.
   */
  const replaceUserCourseAssignments = useCallback(async (userId: string, courseIds: string[]) => {
    return usersApi.replaceUserCourseAssignments(userId, courseIds);
  }, []);

  /**
   * Bulk assign/remove a course for selected users.
   */
  const bulkCourseAssignments = useCallback(async (input: {
    user_ids: string[];
    course_id: string;
    action: "assign" | "remove";
  }) => {
    return usersApi.bulkCourseAssignments(input);
  }, []);

  return {
    users,
    callerRole,
    isLoading,
    error,
    refetch: fetchUsers,
    inviteUser,
    changeUserRole,
    disableUser,
    enableUser,
    deleteUser,
    resendInvite,
    assignOrganization,
    bulkAssignOrganization,
    sendPasswordSetupLink,
    getAssignableCourses,
    getUserCourseAssignments,
    replaceUserCourseAssignments,
    bulkCourseAssignments,
  };
};
