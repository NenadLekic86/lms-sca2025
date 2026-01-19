'use client';

import { createContext, useEffect, useState } from "react";
import { loadAppTheme } from '@/lib/theme/loadTheme';
import { ROLE_PRIMARY_CACHE_KEY, THEME_CACHE_KEY } from "@/lib/theme/themeConstants";

type ThemeContextType = {
  theme: Record<string, string> | null;
};

export const ThemeContext = createContext<ThemeContextType>({
  theme: null,
});

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
  const [theme, setTheme] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    function applyThemeVars(themeVars: Record<string, string>) {
      // If a role-based primary override is cached, never clobber it with the public theme.
      // This prevents visible "primary color bouncing" during dashboard navigations.
      // We scope this to dashboard routes so a stale cache can't affect public pages.
      let rolePrimary: string | null = null;
      let isDashboardRoute = false;
      try {
        const p = window.location?.pathname ?? "";
        isDashboardRoute = p.startsWith("/admin") || p.startsWith("/system") || p.startsWith("/org");
        rolePrimary = isDashboardRoute ? localStorage.getItem(ROLE_PRIMARY_CACHE_KEY) : null;
      } catch {
        rolePrimary = null;
        isDashboardRoute = false;
      }

      Object.entries(themeVars).forEach(([key, value]) => {
        if (isDashboardRoute && key === "--brand-primary" && rolePrimary) return;
        document.documentElement.style.setProperty(key, value);
      });
      setTheme(themeVars);
      try {
        localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(themeVars));
      } catch {
        // ignore storage issues
      }
    }

    async function applyTheme() {
      const themeVars = await loadAppTheme();
      if (!themeVars) return;

      applyThemeVars(themeVars);
    }

    applyTheme();

    // Optional: allow other parts of the app to push a theme update without waiting for refetch.
    const onThemeUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as unknown;
      if (!detail || typeof detail !== "object") return;
      const values = Object.values(detail as Record<string, unknown>);
      if (!values.every((v) => typeof v === "string")) return;
      applyThemeVars(detail as Record<string, string>);
    };

    window.addEventListener("theme:updated", onThemeUpdated as EventListener);
    return () => {
      window.removeEventListener("theme:updated", onThemeUpdated as EventListener);
    };
  }, []);

  return (
    <ThemeContext.Provider value={{ theme }}>
      {children}
    </ThemeContext.Provider>
  );
};
