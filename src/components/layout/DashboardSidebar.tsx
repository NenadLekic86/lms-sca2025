'use client';

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, Loader2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import AppBranding from "../ui/AppBranding";
import { useAuth } from "@/lib/hooks/useAuth";
import { getNavItemsForRole } from "@/config/navigation";
import type { NavItem } from "@/config/navigation";
import { useState } from "react";

export function DashboardSidebar() {
  const { user, dbUser, isLoading } = useAuth();
  const pathname = usePathname();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Avoid UI flashes on public pages (login, forgot/reset password, etc.).
  // On these routes we only show the branding; nav/logout should not appear.
  const isDashboardRoute =
    pathname.startsWith("/admin") || pathname.startsWith("/system") || pathname.startsWith("/org");

  // Get menu items based on role from context (single source of truth)
  const orgKey = dbUser?.organization_slug ?? dbUser?.organization_id ?? null;
  const menuItems: NavItem[] = dbUser?.role 
    ? getNavItemsForRole(dbUser.role, orgKey) 
    : [];

  // Handle logout
  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      // Hard redirect so proxy.ts re-evaluates cookies immediately
      window.location.assign("/");
    } catch (err) {
      console.error('Logout error:', err);
      setIsLoggingOut(false);
    } finally {
      // If we redirect, this never renders again; if it fails, we reset above.
    }
  };

  // Determine a single "active" menu item.
  // We pick the most specific match (longest href) so that:
  // - /org/:orgId is NOT active when you're on /org/:orgId/settings
  // - /admin is NOT active when you're on /admin/users, etc.
  const activeHref = (() => {
    if (!pathname || menuItems.length === 0) return null;

    const candidates = menuItems
      .map((item) => item.href)
      .filter((href) => {
        if (href === pathname) return true;
        // Segment-aware prefix match (avoid accidental matches like "/adminx")
        return pathname.startsWith(href + "/");
      });

    if (candidates.length === 0) return null;

    // Longest match wins (most specific route)
    return candidates.reduce((best, cur) => (cur.length > best.length ? cur : best), candidates[0]);
  })();

  return (
    <aside
      className={`
        ${collapsed ? "w-[70px]" : "w-[260px]"}
        shrink-0 bg-primary text-white flex flex-col h-screen sticky top-0 z-60
        transition-[width] duration-200 ease-in-out
      `}
    >
      {/* Branding + collapse toggle */}
      <div
        className={`${collapsed ? "px-4 mb-7 h-[68px]" : "px-4 mb-7 h-[68px]"} relative flex items-center justify-between`}
      >
        <div className="relative flex items-center">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="inline-flex items-center justify-center rounded-md p-2 text-white/90 ring-1 ring-white/15 bg-white/5 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>

          {/* Collapsed: show full-size logo 53px to the right of the toggle */}
          {collapsed && (
            <div className={`${collapsed ? "absolute left-full ml-[53px] top-[3px] -translate-y-1/2 w-[140px] h-full" : "ml-auto min-w-0"}`}>
              <AppBranding width={140} height={40} />
            </div>
          )}
        </div>

        {/* Expanded: logo on the right */}
        {!collapsed && (
          <div className="min-w-0">
            <AppBranding width={140} height={40} />
          </div>
        )}
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-white/50" />
        </div>
      )}

      {/* Navigation - only show on dashboard routes, and only if user is logged in and has a role */}
      {isDashboardRoute && !isLoading && menuItems.length > 0 && (
        <nav
          className={`
            flex-1 min-h-0 overflow-y-auto space-y-1
            ${collapsed ? "px-2" : "px-4"}
          `}
        >
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeHref === item.href;
            
            return (
              <Link
                key={item.label}
                href={item.href}
                title={collapsed ? item.label : undefined}
                className={`
                  flex items-center rounded-md transition-colors
                  ${collapsed ? "justify-center px-0 py-3" : "gap-3 px-3 py-2.5"}
                  ${isActive 
                    ? 'bg-white/20 text-white font-medium' 
                    : 'text-white/80 hover:bg-white/10 hover:text-white'
                  }
                `}
              >
                <Icon size={20} />
                {collapsed ? (
                  <span className="sr-only">{item.label}</span>
                ) : (
                  <span className="truncate">{item.label}</span>
                )}
              </Link>
            );
          })}
        </nav>
      )}

      {/* Empty space when not logged in (for visual balance) */}
      {(!isDashboardRoute || (!isLoading && menuItems.length === 0)) && <div className="flex-1" />}

      {/* Logout button - only show if logged in */}
      {isDashboardRoute && user && !isLoading && (
        <div className={`${collapsed ? "p-2" : "p-4"} border-t border-white/10`}>
          <button 
            title={collapsed ? "Logout" : undefined}
            className={`
              flex items-center w-full rounded-md text-white/80 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50 cursor-pointer
              ${collapsed ? "justify-center px-0 py-3" : "gap-3 px-3 py-2.5"}
            `}
            onClick={handleLogout}
            disabled={isLoggingOut}
          >
            {isLoggingOut ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <LogOut size={20} />
            )}
            {collapsed ? (
              <span className="sr-only">{isLoggingOut ? 'Logging out...' : 'Logout'}</span>
            ) : (
              <span>{isLoggingOut ? 'Logging out...' : 'Logout'}</span>
            )}
          </button>
        </div>
      )}
    </aside>
  );
}
