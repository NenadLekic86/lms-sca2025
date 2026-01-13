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

// Navigation item type with proper icon typing
export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

// User roles type
export type UserRole = 'super_admin' | 'system_admin' | 'organization_admin' | 'member';

// Navigation configuration by role
export const NAVIGATION: Record<UserRole, NavItem[]> = {
  // 👑 SUPER_ADMIN - Developer (Full access to everything)
  super_admin: [
    { label: 'Dashboard', href: '/admin', icon: LayoutDashboard },
    { label: 'My Profile', href: '/admin/profile', icon: User },
    { label: 'Organizations', href: '/admin/organizations', icon: Building2 },
    { label: 'System Admins', href: '/admin/system-admins', icon: ShieldCheck },
    { label: 'All Users', href: '/admin/users', icon: Users },
    { label: 'All Courses', href: '/admin/courses', icon: BookOpen },
    { label: 'Certificates', href: '/admin/certificates', icon: Award },
    { label: 'Reports', href: '/admin/reports', icon: BarChart3 },
    { label: 'System Settings', href: '/admin/settings', icon: Settings },
    { label: 'Audit Logs', href: '/admin/audit', icon: FileText },
  ],

  // 🏢 SYSTEM_ADMIN - Highest client role
  system_admin: [
    { label: 'Dashboard', href: '/system', icon: LayoutDashboard },
    { label: 'My Profile', href: '/system/profile', icon: User },
    { label: 'Organizations', href: '/system/organizations', icon: Building2 },
    { label: 'Org Admins', href: '/system/org-admins', icon: UserCog },
    { label: 'Users', href: '/system/users', icon: Users },
    { label: 'Courses', href: '/system/courses', icon: BookOpen },
    { label: 'Certificates', href: '/system/certificates', icon: Award },
    { label: 'Reports', href: '/system/reports', icon: BarChart3 },
    { label: 'Export Data', href: '/system/export', icon: Download },
  ],

  // 🏛️ ORGANIZATION_ADMIN - Org-scoped admin
  organization_admin: [
    { label: 'Dashboard', href: '/org/{orgId}', icon: LayoutDashboard },
    { label: 'My Profile', href: '/org/{orgId}/profile', icon: User },
    { label: 'Users', href: '/org/{orgId}/users', icon: Users },
    { label: 'Courses', href: '/org/{orgId}/courses', icon: BookOpen },
    { label: 'Tests', href: '/org/{orgId}/tests', icon: ClipboardList },
    { label: 'Certificates', href: '/org/{orgId}/certificates', icon: Award },
    { label: 'Reports', href: '/org/{orgId}/reports', icon: BarChart3 },
    { label: 'Export Data', href: '/org/{orgId}/export', icon: Download },
    { label: 'Settings', href: '/org/{orgId}/settings', icon: Settings },
  ],

  // 👤 MEMBER - End user
  member: [
    { label: 'My Dashboard', href: '/org/{orgId}', icon: LayoutDashboard },
    { label: 'Courses', href: '/org/{orgId}/courses', icon: BookOpen },
    { label: 'My Courses', href: '/org/{orgId}/my-courses', icon: BookOpen },
    { label: 'My Tests', href: '/org/{orgId}/my-tests', icon: ClipboardList },
    { label: 'My Certificates', href: '/org/{orgId}/certificates', icon: Award },
    { label: 'My Profile', href: '/org/{orgId}/profile', icon: User },
  ],
};

// Helper function to get navigation items with orgId replaced
export function getNavItemsForRole(role: UserRole, orgId?: string | null): NavItem[] {
  const items = NAVIGATION[role];
  
  if (!orgId) return items;
  
  return items.map(item => ({
    ...item,
    href: item.href.replace('{orgId}', orgId),
  }));
}
