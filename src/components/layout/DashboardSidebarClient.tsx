'use client';

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, Loader2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { NAV_ICONS, type NavItem } from "@/config/navigation";
import { ROLE_PRIMARY_CACHE_KEY } from "@/lib/theme/themeConstants";
import { useRef, useState } from "react";

type DashboardSidebarClientProps = {
  menuItems: NavItem[];
  canLogout: boolean;
};

export function DashboardSidebarClient({ menuItems, canLogout }: DashboardSidebarClientProps) {
  const pathname = usePathname();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [collapseTooltipSide, setCollapseTooltipSide] = useState<"left" | "right">("right");
  const collapseToggleRef = useRef<HTMLButtonElement | null>(null);

  // Avoid UI flashes on public pages (login, forgot/reset password, etc.).
  // On these routes we only show the branding; nav/logout should not appear.
  const isDashboardRoute =
    pathname.startsWith("/admin") || pathname.startsWith("/system") || pathname.startsWith("/org");

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

  // Handle logout
  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      try {
        localStorage.removeItem(ROLE_PRIMARY_CACHE_KEY);
      } catch {
        // ignore
      }
      await fetch("/api/auth/logout", { method: "POST" });
      // Hard redirect so proxy.ts re-evaluates cookies immediately
      window.location.assign("/");
    } catch (err) {
      console.error("Logout error:", err);
      setIsLoggingOut(false);
    } finally {
      // If we redirect, this never renders again; if it fails, we reset above.
    }
  };

  return (
    <aside
      className={`
        ${collapsed ? "w-[70px]" : "w-[260px]"}
        shrink-0 bg-primary text-white flex flex-col h-[calc(100vh-4rem)] sticky top-16 z-60
        transition-[width] duration-200 ease-in-out
      `}
    >
      {/* Collapse toggle */}
      <div className="p-4 mb-7 relative flex items-center justify-end">
        <div className="relative group">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            ref={collapseToggleRef}
            onMouseEnter={() => {
              const el = collapseToggleRef.current;
              if (!el) return;
              const rect = el.getBoundingClientRect();
              const shouldFlip = rect.left < 140;
              setCollapseTooltipSide(shouldFlip ? "right" : "left");
            }}
            className="inline-flex items-center justify-center rounded-md p-2 text-white/90 ring-1 ring-white/15 bg-white/5 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <span
            className={`pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded px-2 py-1 text-xs text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100 bg-[#222] ${
              collapseTooltipSide === "left" ? "right-full mr-2" : "left-full ml-2"
            }`}
          >
            {collapsed ? "Expand sidebar" : "Collapse sidebar"}
          </span>
        </div>
      </div>

      {/* Navigation - only show on dashboard routes, and only if user is logged in and has a role */}
      {isDashboardRoute && menuItems.length > 0 && (
        <nav
          className={`
            flex-1 min-h-0 overflow-y-auto space-y-1
            ${collapsed ? "px-2" : "px-4"}
          `}
        >
          {menuItems.map((item) => {
            const Icon = NAV_ICONS[item.iconKey] ?? NAV_ICONS.LayoutDashboard;
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
                    ? "bg-white/20 text-white font-medium" 
                    : "text-white/80 hover:bg-white/10 hover:text-white"
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
          {canLogout && (
            <button
              title={collapsed ? "Logout" : undefined}
              className={`
                flex items-center rounded-md transition-colors text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-50 mt-10 w-full cursor-pointer
                ${collapsed ? "justify-center px-0 py-3 w-full" : "gap-3 px-3 py-2.5 w-full"}
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
                <span className="sr-only">{isLoggingOut ? "Logging out..." : "Logout"}</span>
              ) : (
                <span>{isLoggingOut ? "Logging out..." : "Logout"}</span>
              )}
            </button>
          )}
        </nav>
      )}

      {/* Empty space when not logged in (for visual balance) */}
      {(!isDashboardRoute || menuItems.length === 0) && <div className="flex-1" />}

      <div className={`mt-auto sticky bottom-0 px-3 py-1 min-h-[53px] text-white/70 bg-primary border-t border-white/10 ${collapsed ? "text-xs" : "text-sm"}`}>
        © 2026 Smart Consulting Agency. All rights reserved.
      </div>
    </aside>
  );
}
