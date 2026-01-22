import "server-only";

import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { env } from '@/env.mjs';
import type { Role } from "@/types";

/**
 * Server client with user's session (for authenticated operations)
 * Uses cookies to maintain user session
 */
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component context
          }
        },
      },
    }
  );
}

/**
 * Admin client with SERVICE ROLE key (for admin operations only!)
 * ⚠️ NEVER expose this to the client - server-side only
 * Used for: inviting users, admin auth operations
 */
export function createAdminSupabaseClient() {
  return createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        flowType: "implicit",
      },
    }
  );
}

export type UserRole = Role;

export interface DbUser {
  id: string;
  email: string;
  role: Role;
  organization_id: string | null;
  is_active?: boolean | null;
  full_name?: string | null;
  avatar_url?: string | null;
}

async function getDbUserRowById(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  userId: string
): Promise<{ user: DbUser | null; error: string | null }> {
  // Prefer selecting full_name + avatar_url if the columns exist; fall back gracefully if a migration
  // hasn't been applied yet.
  const withCols = await supabase
    .from('users')
    .select('id, email, role, organization_id, is_active, full_name, avatar_url')
    .eq('id', userId)
    .single();

  if (!withCols.error && withCols.data) {
    return { user: withCols.data as DbUser, error: null };
  }

  const msg = withCols.error?.message ?? '';
  const looksLikeMissingFullName =
    /full_name/i.test(msg) && (/schema cache/i.test(msg) || /column/i.test(msg) || /does not exist/i.test(msg));
  const looksLikeMissingAvatarUrl =
    /avatar_url/i.test(msg) && (/schema cache/i.test(msg) || /column/i.test(msg) || /does not exist/i.test(msg));

  if (!looksLikeMissingFullName && !looksLikeMissingAvatarUrl) {
    return { user: null, error: msg || 'User not found in database' };
  }

  const withoutCols = await supabase
    .from('users')
    .select('id, email, role, organization_id, is_active')
    .eq('id', userId)
    .single();

  if (withoutCols.error || !withoutCols.data) {
    return { user: null, error: withoutCols.error?.message || 'User not found in database' };
  }

  return {
    user: {
      ...(withoutCols.data as DbUser),
      full_name: looksLikeMissingFullName ? null : undefined,
      avatar_url: looksLikeMissingAvatarUrl ? null : undefined,
    },
    error: null,
  };
}

/**
 * Get current user with their database role (for server components/layouts)
 */
export async function getServerUser(): Promise<{ user: DbUser | null; error: string | null }> {
  const supabase = await createServerSupabaseClient();
  
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  
  if (authError || !user) {
    return { user: null, error: 'Not authenticated' };
  }

  const { user: dbUser, error: dbError } = await getDbUserRowById(supabase, user.id);

  if (dbError || !dbUser) return { user: null, error: dbError || 'User not found in database' };

  const typed = dbUser as DbUser;

  if (typed.is_active === false) {
    return { user: null, error: 'Account disabled' };
  }

  return { user: typed, error: null };
}

