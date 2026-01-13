/**
 * @deprecated This service is DEPRECATED and should NOT be used.
 * 
 * ⚠️ SECURITY WARNING: This service bypasses RPC and RLS protections by directly
 * accessing the 'users' table from the client. This is a security risk.
 * 
 * ✅ USE INSTEAD: 
 * - For frontend: import { usersApi } from '@/features/users/api/users.api'
 * - For hooks: import { useUsers } from '@/features/users/hooks/useUsers'
 * 
 * These use server-side API routes that properly call RPCs with permission checks.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DEPRECATED_WARNING = `
  DO NOT USE THIS SERVICE.
  All user operations must go through:
  - /api/users (GET - list users via RPC)
  - /api/users/invite (POST - invite via Admin API + profile insert)
  - /api/users/[id]/role (PATCH - change role via RPC)
  - /api/users/[id]/disable (PATCH - disable via RPC)
`;

export class UserService {
  /** @deprecated Use usersApi.getUsers() instead */
  static async getUsers() {
    throw new Error('DEPRECATED: Use usersApi.getUsers() from @/features/users/api/users.api');
  }

  /** @deprecated Use usersApi.inviteUser() instead */
  static async inviteUser() {
    throw new Error('DEPRECATED: Use usersApi.inviteUser() from @/features/users/api/users.api');
  }

  /** @deprecated Use usersApi.changeUserRole() instead */
  static async updateUser() {
    throw new Error('DEPRECATED: Use usersApi.changeUserRole() from @/features/users/api/users.api');
  }

  /** @deprecated Use usersApi.disableUser() instead */
  static async deleteUser() {
    throw new Error('DEPRECATED: Use usersApi.disableUser() from @/features/users/api/users.api');
  }
}
