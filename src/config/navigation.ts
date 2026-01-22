import {
  LayoutDashboard,
  Building2,
  ShieldCheck,
  Users,
  UserCog,
  BookOpen,
  ClipboardList,
  Award,
  BarChart3,
  Download,
  Settings,
  FileText,
  User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Role } from "@/types";

export type NavIconKey =
  | "LayoutDashboard"
  | "Building2"
  | "ShieldCheck"
  | "Users"
  | "UserCog"
  | "BookOpen"
  | "ClipboardList"
  | "Award"
  | "BarChart3"
  | "Download"
  | "Settings"
  | "FileText"
  | "User";

export const NAV_ICONS: Record<NavIconKey, LucideIcon> = {
  LayoutDashboard,
  Building2,
  ShieldCheck,
  Users,
  UserCog,
  BookOpen,
  ClipboardList,
  Award,
  BarChart3,
  Download,
  Settings,
  FileText,
  User,
};

// Navigation item type with serializable icon keys
export interface NavItem {
  label: string;
  href: string;
  iconKey: NavIconKey;
}

// User roles type
export type UserRole = Role;

// Navigation configuration by role
export const NAVIGATION: Record<Role, NavItem[]> = {
  // 👑 SUPER_ADMIN - Developer (Full access to everything)
  super_admin: [
    { label: 'Dashboard', href: '/admin', iconKey: "LayoutDashboard" },
    { label: 'My Profile', href: '/admin/profile', iconKey: "User" },
    { label: 'Organizations', href: '/admin/organizations', iconKey: "Building2" },
    { label: 'System Admins', href: '/admin/system-admins', iconKey: "ShieldCheck" },
    { label: 'All Users', href: '/admin/users', iconKey: "Users" },
    { label: 'Certificates', href: '/admin/certificates', iconKey: "Award" },
    { label: 'Reports', href: '/admin/reports', iconKey: "BarChart3" },
    { label: 'System Settings', href: '/admin/settings', iconKey: "Settings" },
    { label: 'System Reports', href: '/admin/system-reports', iconKey: "BarChart3" },
    { label: 'Audit Logs', href: '/admin/audit', iconKey: "FileText" },
  ],

  // 🏢 SYSTEM_ADMIN - Highest client role
  system_admin: [
    { label: 'Dashboard', href: '/system', iconKey: "LayoutDashboard" },
    { label: 'My Profile', href: '/system/profile', iconKey: "User" },
    { label: 'Organizations', href: '/system/organizations', iconKey: "Building2" },
    { label: 'Org Admins', href: '/system/org-admins', iconKey: "UserCog" },
    { label: 'Users', href: '/system/users', iconKey: "Users" },
    { label: 'Certificates', href: '/system/certificates', iconKey: "Award" },
    { label: 'Reports', href: '/system/reports', iconKey: "BarChart3" },
    { label: 'Export Data', href: '/system/export', iconKey: "Download" },
  ],

  // 🏛️ ORGANIZATION_ADMIN - Org-scoped admin
  organization_admin: [
    { label: 'Dashboard', href: '/org/{orgId}', iconKey: "LayoutDashboard" },
    { label: 'My Profile', href: '/org/{orgId}/profile', iconKey: "User" },
    { label: 'Users', href: '/org/{orgId}/users', iconKey: "Users" },
    { label: 'Courses', href: '/org/{orgId}/courses', iconKey: "BookOpen" },
    { label: 'Tests', href: '/org/{orgId}/tests', iconKey: "ClipboardList" },
    { label: 'Certificates', href: '/org/{orgId}/certificates', iconKey: "Award" },
    { label: 'Reports', href: '/org/{orgId}/reports', iconKey: "BarChart3" },
    { label: 'Export Data', href: '/org/{orgId}/export', iconKey: "Download" },
    { label: 'Settings', href: '/org/{orgId}/settings', iconKey: "Settings" },
  ],

  // 👤 MEMBER - End user
  member: [
    { label: 'My Dashboard', href: '/org/{orgId}', iconKey: "LayoutDashboard" },
    { label: 'Courses', href: '/org/{orgId}/courses', iconKey: "BookOpen" },
    { label: 'My Courses', href: '/org/{orgId}/my-courses', iconKey: "BookOpen" },
    { label: 'My Tests', href: '/org/{orgId}/my-tests', iconKey: "ClipboardList" },
    { label: 'My Certificates', href: '/org/{orgId}/certificates', iconKey: "Award" },
    { label: 'My Profile', href: '/org/{orgId}/profile', iconKey: "User" },
  ],
};

// Helper function to get navigation items with orgId replaced
export function getNavItemsForRole(role: Role, orgId?: string | null): NavItem[] {
  const items = NAVIGATION[role];
  
  if (!orgId) return items;
  
  return items.map(item => ({
    ...item,
    href: item.href.replace('{orgId}', orgId),
  }));
}
