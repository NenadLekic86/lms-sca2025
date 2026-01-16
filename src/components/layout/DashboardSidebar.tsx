import { getNavItemsForRole, type NavItem, type UserRole } from "@/config/navigation";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";
import { getServerUser } from "@/lib/supabase/server";
import { DashboardSidebarClient } from "./DashboardSidebarClient";

export async function DashboardSidebar() {
  const { user } = await getServerUser();

  let menuItems: NavItem[] = [];
  let canLogout = false;

  if (user?.role) {
    canLogout = true;
    const role = user.role as UserRole;
    const isOrgRole = role === "organization_admin" || role === "member";

    if (isOrgRole) {
      const orgId = user.organization_id ?? null;
      if (orgId) {
        const resolved = await resolveOrgKey(orgId);
        const orgKey = resolved.org?.slug ?? orgId;
        menuItems = getNavItemsForRole(role, orgKey);
      } else {
        menuItems = [];
      }
    } else {
      menuItems = getNavItemsForRole(role);
    }
  }

  return <DashboardSidebarClient menuItems={menuItems} canLogout={canLogout} />;
}
