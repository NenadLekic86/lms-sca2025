'use client'

import { createContext, useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase/client";
import { User } from "@supabase/supabase-js";
import type { Role } from "@/types";

// User role type (single source of truth)
export type UserRole = Role;

// Database user info
export interface DbUser {
  id: string;
  email: string;
  role: Role;
  organization_id: string | null;
  organization_slug?: string | null;
  is_active?: boolean | null;
  full_name?: string | null;
  avatar_url?: string | null;
}

// Auth context type - single source of truth
interface AuthContextType {
  user: User | null;           // Supabase auth user
  dbUser: DbUser | null;       // Database user with role
  isLoading: boolean;          // Loading state
  refreshUser: () => Promise<void>; // Manually refresh user data
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  dbUser: null,
  isLoading: true,
  refreshUser: async () => {},
});

const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [dbUser, setDbUser] = useState<DbUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch database user info (role, organization_id)
  const fetchDbUser = useCallback(async (authUser: User | null) => {
    if (!authUser) {
      setDbUser(null);
      return;
    }

    try {
      // Prefer selecting full_name + avatar_url if the columns exist; fall back if migrations aren't applied yet.
      const withCols = await supabase
        .from('users')
        .select('id, email, role, organization_id, is_active, full_name, avatar_url')
        .eq('id', authUser.id)
        .single();

      const missingFullNameColumn =
        !!withCols.error &&
        /full_name/i.test(withCols.error.message || "") &&
        (/schema cache/i.test(withCols.error.message || "") ||
          /column/i.test(withCols.error.message || "") ||
          /does not exist/i.test(withCols.error.message || ""));

      const missingAvatarColumn =
        !!withCols.error &&
        /avatar_url/i.test(withCols.error.message || "") &&
        (/schema cache/i.test(withCols.error.message || "") ||
          /column/i.test(withCols.error.message || "") ||
          /does not exist/i.test(withCols.error.message || ""));

      const { data, error } = missingFullNameColumn || missingAvatarColumn
        ? await supabase
            .from('users')
            .select('id, email, role, organization_id, is_active')
            .eq('id', authUser.id)
            .single()
        : withCols;

      if (error || !data) {
        console.warn('Failed to fetch db user:', error?.message);
        setDbUser(null);
        return;
      }

      const next = data as DbUser;
      if (missingFullNameColumn) next.full_name = null;
      if (missingAvatarColumn) next.avatar_url = null;

      // Option A: fetch org slug for org-scoped routing (best-effort; RLS applies)
      try {
        const orgId = next.organization_id;
        if (orgId && typeof orgId === "string") {
          const { data: orgData, error: orgError } = await supabase
            .from("organizations")
            .select("slug")
            .eq("id", orgId)
            .maybeSingle();
          if (!orgError) {
            const raw = (orgData as { slug?: unknown } | null)?.slug;
            next.organization_slug = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
          } else {
            next.organization_slug = null;
          }
        } else {
          next.organization_slug = null;
        }
      } catch {
        next.organization_slug = null;
      }

      setDbUser(next);
    } catch (err) {
      console.error('Error fetching db user:', err);
      setDbUser(null);
    }
  }, []);

  // Manual refresh function
  const refreshUser = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const authUser = session?.user || null;
    setUser(authUser);
    await fetchDbUser(authUser);
  }, [fetchDbUser]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      setIsLoading(true);
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        const authUser = data.session?.user || null;
        if (cancelled) return;
        setUser(authUser);
        await fetchDbUser(authUser);
      } catch (err) {
        console.error("AuthProvider getSession error:", err);
        if (!cancelled) {
          setUser(null);
          setDbUser(null);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void init();

    // Allow other parts of the app to request a user refresh (e.g. after profile update).
    const onProfileUpdated = () => {
      void refreshUser();
    };
    window.addEventListener("profile:updated", onProfileUpdated);

    // Listen for auth state changes
    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      try {
        const authUser = session?.user || null;
        setUser(authUser);
        await fetchDbUser(authUser);
      } catch (err) {
        console.error("AuthProvider onAuthStateChange error:", err);
        setUser(null);
        setDbUser(null);
      } finally {
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
      window.removeEventListener("profile:updated", onProfileUpdated);
      listener.subscription.unsubscribe();
    };
  }, [fetchDbUser, refreshUser]);

  return (
    <AuthContext.Provider value={{ user, dbUser, isLoading, refreshUser }}>
      {/* Never hard-block rendering with a full-screen loader.
          Route guards (proxy + server layouts) already protect pages, and the sidebar
          can show its own loading state. This also prevents getting "stuck" on Loading. */}
      {children}
    </AuthContext.Provider>
  );
};

export { AuthContext, AuthProvider };
