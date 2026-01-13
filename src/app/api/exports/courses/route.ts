import { NextRequest, NextResponse } from "next/server";

import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

type CourseRow = {
  id: string;
  title?: string | null;
  organization_id?: string | null;
  visibility_scope?: string | null;
  is_published?: boolean | null;
  is_archived?: boolean | null;
  estimated_duration_text?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
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
  if (user.role === "member") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const orgIdParam = url.searchParams.get("orgId");
  const max = Math.min(parseIntParam(url.searchParams.get("max"), 50000), 50000);

  // Permission enforcement
  let effectiveOrgId: string | null = orgIdParam;
  if (user.role === "organization_admin") {
    if (!user.organization_id) return NextResponse.json({ error: "Missing organization" }, { status: 400 });
    if (orgIdParam && orgIdParam !== user.organization_id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    effectiveOrgId = user.organization_id;
  }

  const admin = createAdminSupabaseClient();

  // Rate limit: 2 exports per 30 minutes per user per export type
  try {
    const windowStartIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { count, error: rateErr } = await admin
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("actor_user_id", user.id)
      .eq("action", "export_courses")
      .gte("created_at", windowStartIso);
    if (!rateErr && typeof count === "number" && count >= 2) {
      return NextResponse.json(
        { error: "Rate limit: you can export Courses (CSV) up to 2 times per 30 minutes." },
        { status: 429 }
      );
    }
  } catch {
    // ignore rate limit failures (do not block exports)
  }

  let q = admin
    .from("courses")
    .select("id, title, organization_id, visibility_scope, is_published, is_archived, estimated_duration_text, created_at, updated_at")
    .order("created_at", { ascending: false })
    .range(0, Math.max(0, max - 1));

  if (effectiveOrgId && effectiveOrgId.length > 0) {
    q = q.eq("organization_id", effectiveOrgId);
  }

  const { data, error: loadError } = await q;
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });

  const rows = (Array.isArray(data) ? data : []) as CourseRow[];

  const exportRows = rows.map((r) => ({
    id: r.id,
    title: (r.title ?? "").trim(),
    organization_id: r.organization_id ?? "",
    visibility_scope: r.visibility_scope ?? "",
    is_published: r.is_published === true ? "true" : "false",
    is_archived: r.is_archived === true ? "true" : "false",
    estimated_duration_text: (r.estimated_duration_text ?? "").trim(),
    created_at: r.created_at ?? "",
    updated_at: r.updated_at ?? "",
  }));

  const csv = buildCsv(exportRows);
  const filename = effectiveOrgId ? `courses-${effectiveOrgId}.csv` : "courses-all.csv";

  // Best-effort audit log (do not block exports)
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: user.id,
      actor_email: user.email,
      actor_role: user.role,
      action: "export_courses",
      entity: effectiveOrgId ? "organizations" : "system",
      entity_id: effectiveOrgId,
      metadata: {
        organization_id: effectiveOrgId ?? null,
        export: "courses",
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

