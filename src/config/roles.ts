import type { Role } from "@/types";

export type Capability =
  | "manage_system_admins"
  | "manage_orgs"
  | "manage_org_admins"
  | "view_all_users"
  | "audit_logs"
  | "view_reports"
  | "manage_users"
  | "manage_courses"
  | "view_courses"
  | "take_tests";

export const ROLE_CAPABILITIES: Record<Role, Record<Capability, boolean>> = {
  super_admin: {
    manage_system_admins: true,
    manage_orgs: true,
    manage_org_admins: true,
    view_all_users: true,
    audit_logs: true,
    view_reports: true,
    manage_users: true,
    manage_courses: true,
    view_courses: true,
    take_tests: true,
  },
  system_admin: {
    manage_system_admins: false,
    manage_orgs: true,
    manage_org_admins: true,
    view_all_users: true,
    audit_logs: false,
    view_reports: true,
    manage_users: false,
    manage_courses: true,
    view_courses: true,
    take_tests: false,
  },
  organization_admin: {
    manage_system_admins: false,
    manage_orgs: false,
    manage_org_admins: false,
    view_all_users: false,
    audit_logs: false,
    view_reports: true,
    manage_users: true,
    manage_courses: true,
    view_courses: true,
    take_tests: false,
  },
  member: {
    manage_system_admins: false,
    manage_orgs: false,
    manage_org_admins: false,
    view_all_users: false,
    audit_logs: false,
    view_reports: false,
    manage_users: false,
    manage_courses: false,
    view_courses: true,
    take_tests: true,
  },
};

export function hasCapability(role: Role, capability: Capability): boolean {
  return !!ROLE_CAPABILITIES[role]?.[capability];
}