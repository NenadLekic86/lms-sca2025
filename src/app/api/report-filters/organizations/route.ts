import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

function parseIntParam(v: string | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function humanizeSlug(slug: string): string {
  // "acme-inc_ltd" -> "Acme Inc Ltd"
  const s = slug
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  if (!s) return "";
  return s
    .split(" ")
    .map((p) => (p.length > 0 ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

export async function GET(request: NextRequest) {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["super_admin", "system_admin"].includes(caller.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const page = parseIntParam(url.searchParams.get("page"), 1);
  const pageSize = Math.min(parseIntParam(url.searchParams.get("page_size"), 20), 50);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const admin = createAdminSupabaseClient();
  let query = admin
    .from("organizations")
    .select("id, name, slug, is_active, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (q.length > 0) {
    const s = q.replace(/,+/g, " ").slice(0, 120);
    query = query.or(`name.ilike.%${s}%,slug.ilike.%${s}%`);
  }

  const { data, error: loadError, count } = await query;
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });

  const orgs = Array.isArray(data) ? (data as Array<{ id: string; name?: string | null; slug?: string | null; is_active?: boolean | null }>) : [];

  return NextResponse.json({
    organizations: orgs,
    items: orgs.map((o) => ({
      id: o.id,
      // Never expose IDs/slugs in the UI label.
      label:
        (o.name && o.name.trim().length > 0 ? o.name.trim() : null) ??
        (o.slug && o.slug.trim().length > 0 ? humanizeSlug(o.slug) : null) ??
        "Unnamed organization",
      meta: o.is_active === false ? "Inactive" : "Active",
    })),
    page,
    page_size: pageSize,
    total: typeof count === "number" ? count : 0,
  });
}

