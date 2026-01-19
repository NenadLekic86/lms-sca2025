'use client';

import { useEffect, useMemo, useContext } from "react";
import { ThemeContext } from "@/context/ThemeProvider";
import { useAuth } from "@/lib/hooks/useAuth";
import { ROLE_PRIMARY_CACHE_KEY, THEME_CACHE_KEY } from "@/lib/theme/themeConstants";

type Role = "super_admin" | "system_admin" | "organization_admin" | "member";

const DEFAULTS = {
  admin: "#F58131", // super_admin + system_admin
  orgadmin: "#334158",
  member: "#6582A0",
} as const;

function safeGetCachedTheme(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof k === "string" && k.startsWith("--") && typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

function pickRoleBucket(role: Role): "admin" | "orgadmin" | "member" {
  if (role === "super_admin" || role === "system_admin") return "admin";
  if (role === "organization_admin") return "orgadmin";
  return "member";
}

export function RolePrimaryThemeOverride() {
  const { dbUser } = useAuth();
  const { theme } = useContext(ThemeContext);

  const role = (dbUser?.role ?? null) as Role | null;

  const desiredPrimary = useMemo(() => {
    if (!role) return null;
    const bucket = pickRoleBucket(role);
    const vars = theme ?? safeGetCachedTheme();
    const key = `--brand-primary-${bucket}`;
    const fromTheme = vars?.[key];
    if (typeof fromTheme === "string" && fromTheme.trim().length > 0) return fromTheme.trim();
    return DEFAULTS[bucket];
  }, [role, theme]);

  useEffect(() => {
    try {
      if (!desiredPrimary) {
        // Logged out or role unknown: clear override and cache.
        document.documentElement.style.removeProperty("--brand-primary");
        localStorage.removeItem(ROLE_PRIMARY_CACHE_KEY);
        return;
      }

      document.documentElement.style.setProperty("--brand-primary", desiredPrimary);
      localStorage.setItem(ROLE_PRIMARY_CACHE_KEY, desiredPrimary);
    } catch {
      // ignore storage/DOM issues
    }
  }, [desiredPrimary]);

  return null;
}

