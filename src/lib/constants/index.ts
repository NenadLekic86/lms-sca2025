// Role constants - matches Role type in src/types.ts
export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  SYSTEM_ADMIN: 'system_admin',
  ORGANIZATION_ADMIN: 'organization_admin',
  MEMBER: 'member',
} as const;

// Permission constants - matches Permission type in src/types.ts
export const PERMISSIONS = {
  MANAGE_USERS: 'manage_users',
  MANAGE_COURSES: 'manage_courses',
  MANAGE_TESTS: 'manage_tests',
  MANAGE_CERTIFICATES: 'manage_certificates',
} as const;

// Role type derived from constants (for type safety)
export type RoleValue = typeof ROLES[keyof typeof ROLES];

// Permission type derived from constants
export type PermissionValue = typeof PERMISSIONS[keyof typeof PERMISSIONS];
