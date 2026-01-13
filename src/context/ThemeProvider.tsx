'use client';

import { createContext, useEffect, useState } from "react";
import { loadAppTheme } from '@/lib/theme/loadTheme';
import { THEME_CACHE_KEY } from "@/lib/theme/themeConstants";

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
      Object.entries(themeVars).forEach(([key, value]) => {
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
