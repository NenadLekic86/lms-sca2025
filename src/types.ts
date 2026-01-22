// User roles - single source of truth
export const ROLES = ["super_admin", "system_admin", "organization_admin", "member"] as const;
export type Role = (typeof ROLES)[number];

// Permissions/capabilities
export type Permission = 'manage_users' | 'manage_courses' | 'manage_tests' | 'manage_certificates';

export interface AppUser {
  id: string;
  email: string;
  role: Role;
  organizationId?: string;
}

export interface AppOrganization {
  id: string;
  name: string;
  slug: string;
  theme?: Record<string, string>;
}
