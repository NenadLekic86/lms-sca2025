import { createServerSupabaseClient } from "@/lib/supabase/server";

export type ResolvedOrg = {
  id: string;
  slug: string;
  name: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(input: string): boolean {
  return UUID_RE.test(input);
}

/**
 * Resolve an org route param (uuid OR slug) into a real org row.
 *
 * IMPORTANT:
 * - Uses the user's session client (RLS applies).
 * - For org-scoped roles, this prevents leaking org existence outside their org.
 */
export async function resolveOrgKey(orgKeyRaw: string): Promise<{
  org: ResolvedOrg | null;
  orgKey: string;
  isUuidKey: boolean;
  error: string | null;
}> {
  const orgKey = (orgKeyRaw ?? "").trim();
  const isUuidKey = isUuid(orgKey);

  if (!orgKey) {
    return { org: null, orgKey, isUuidKey, error: "Missing organization key" };
  }

  const supabase = await createServerSupabaseClient();
  const q = supabase
    .from("organizations")
    .select("id, slug, name")
    .limit(1);

  const { data, error } = isUuidKey
    ? await q.eq("id", orgKey).maybeSingle()
    : await q.eq("slug", orgKey.toLowerCase()).maybeSingle();

  if (error || !data) {
    return { org: null, orgKey, isUuidKey, error: error?.message ?? null };
  }

  const id = typeof (data as { id?: unknown }).id === "string" ? (data as { id: string }).id : null;
  if (!id) return { org: null, orgKey, isUuidKey, error: "Organization id missing" };

  const slugRaw = (data as { slug?: unknown }).slug;
  const slug =
    typeof slugRaw === "string" && slugRaw.trim().length > 0 ? slugRaw.trim() : id;
  const nameRaw = (data as { name?: unknown }).name;
  const name =
    typeof nameRaw === "string" && nameRaw.trim().length > 0 ? nameRaw.trim() : null;

  return { org: { id, slug, name }, orgKey, isUuidKey, error: null };
}

