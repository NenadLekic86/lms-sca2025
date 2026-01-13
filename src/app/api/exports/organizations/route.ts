import { NextRequest, NextResponse } from "next/server";

import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

type OrgRow = {
  id: string;
  name?: string | null;
  slug?: string | null;
  is_active?: boolean | null;
  created_at?: string | null;
};

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  const escaped = s.replace(/"/g, '""');
  return `"${escaped}"`;
}

function buildCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "No data\n";
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.map(csvEscape).join(","),
    ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")),
  ];
  return lines.join("\n") + "\n";
}

function parseIntParam(v: string | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function GET(request: NextRequest) {
  const { user, error } = await getServerUser();
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["super_admin", "system_admin"].includes(user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const max = Math.min(parseIntParam(url.searchParams.get("max"), 50000), 50000);

  const admin = createAdminSupabaseClient();

  // Rate limit: 2 exports per 30 minutes per user per export type
  try {
    const windowStartIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { count, error: rateErr } = await admin
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("actor_user_id", user.id)
      .eq("action", "export_organizations")
      .gte("created_at", windowStartIso);
    if (!rateErr && typeof count === "number" && count >= 2) {
      return NextResponse.json(
        { error: "Rate limit: you can export Organizations (CSV) up to 2 times per 30 minutes." },
        { status: 429 }
      );
    }
  } catch {
    // ignore rate limit failures (do not block exports)
  }

  const { data, error: loadError } = await admin
    .from("organizations")
    .select("id, name, slug, is_active, created_at")
    .order("created_at", { ascending: false })
    .range(0, Math.max(0, max - 1));

  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });

  const rows = (Array.isArray(data) ? data : []) as OrgRow[];

  const exportRows = rows.map((r) => ({
    id: r.id,
    name: (r.name ?? "").trim(),
    slug: (r.slug ?? "").trim(),
    is_active: r.is_active === false ? "false" : "true",
    created_at: r.created_at ?? "",
  }));

  const csv = buildCsv(exportRows);
  const filename = "organizations-all.csv";

  // Best-effort audit log (do not block exports)
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: user.id,
      actor_email: user.email,
      actor_role: user.role,
      action: "export_organizations",
      entity: "system",
      entity_id: null,
      metadata: {
        organization_id: null,
        export: "organizations",
        format: "csv",
        row_count: exportRows.length,
        max,
      },
    });
  } catch {
    // ignore
  }

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

