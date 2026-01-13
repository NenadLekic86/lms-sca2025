import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

function parseIntParam(v: string | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function GET(request: NextRequest) {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["super_admin", "system_admin", "organization_admin"].includes(caller.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const requestedOrgId = url.searchParams.get("organization_id");
  const q = (url.searchParams.get("q") ?? "").trim();
  const page = parseIntParam(url.searchParams.get("page"), 1);
  const pageSize = Math.min(parseIntParam(url.searchParams.get("page_size"), 20), 50);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let orgId: string | null = requestedOrgId;
  if (caller.role === "organization_admin") {
    if (!caller.organization_id) return NextResponse.json({ error: "Missing organization" }, { status: 400 });
    // Org admins can only list their org.
    orgId = caller.organization_id;
  }

  const admin = createAdminSupabaseClient();
  let query = admin
    .from("users")
    .select("id, email, full_name, role, organization_id, is_active", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (orgId) query = query.eq("organization_id", orgId);
  if (caller.role === "system_admin") {
    // Hardening: system_admin should not see super_admin user.
    query = query.neq("role", "super_admin");
  }

  if (q.length > 0) {
    const s = q.replace(/,+/g, " ").slice(0, 120);
    query = query.or(`email.ilike.%${s}%,full_name.ilike.%${s}%`);
  }

  const { data, error: loadError, count } = await query;
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });

  const users = Array.isArray(data)
    ? (data as Array<{ id: string; email?: string | null; full_name?: string | null; role?: string | null; organization_id?: string | null; is_active?: boolean | null }>)
    : [];

  return NextResponse.json({
    users,
    items: users.map((u) => ({
      id: u.id,
      label:
        (u.full_name && u.full_name.trim().length > 0 ? u.full_name.trim() : null) ??
        (u.email && u.email.trim().length > 0 ? u.email.trim() : null) ??
        "Unknown user",
      meta: `${(u.email && u.email.trim().length > 0 ? u.email.trim() : "No email")} • ${u.role ?? "unknown"}${u.is_active === false ? " • disabled" : ""}`,
    })),
    page,
    page_size: pageSize,
    total: typeof count === "number" ? count : 0,
  });
}

