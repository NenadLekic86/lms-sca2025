// Re-export from centralized schemas for backwards compatibility
export { 
  inviteUserSchema as userSchema,
  changeRoleSchema as updateUserSchema,
  roleEnum,
  type Role,
} from '@/lib/validations/schemas';

// Keep local types for backwards compatibility with existing code
export type UserFormData = {
  email: string;
  full_name?: string | null;
  role: 'super_admin' | 'system_admin' | 'organization_admin' | 'member';
  organization_id?: string | null;
};

export type UpdateUserFormData = {
  role?: 'super_admin' | 'system_admin' | 'organization_admin' | 'member';
};
