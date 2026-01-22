// Re-export from centralized schemas for backwards compatibility
export { 
  inviteUserSchema as userSchema,
  changeRoleSchema as updateUserSchema,
  roleEnum,
} from '@/lib/validations/schemas';

// Role/type single source of truth
export type { Role } from "@/types";

// Keep local types for backwards compatibility with existing code
export type UserFormData = {
  email: string;
  full_name?: string | null;
  role: import("@/types").Role;
  organization_id?: string | null;
};

export type UpdateUserFormData = {
  role?: import("@/types").Role;
};
