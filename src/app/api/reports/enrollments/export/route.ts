import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { fetchEnrollmentTestSummary, formatDurationSeconds } from "@/services/reporting.service";

export const runtime = "nodejs";

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

export async function GET(request: NextRequest) {
  const { user, error } = await getServerUser();
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "member") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);

  // Filters (optional)
  const orgId = url.searchParams.get("orgId") || undefined;
  const courseId = url.searchParams.get("courseId") || undefined;
  const userId = url.searchParams.get("userId") || undefined;
  const result = (url.searchParams.get("result") || "all") as "all" | "passed" | "failed" | "not_submitted";
  const q = url.searchParams.get("q") || undefined;
  const from = url.searchParams.get("from") || undefined;
  const to = url.searchParams.get("to") || undefined;
  const max = Number(url.searchParams.get("max") || "50000");

  // Permission enforcement
  let effectiveOrgId: string | undefined = orgId ?? undefined;
  if (user.role === "organization_admin") {
    if (!user.organization_id) return NextResponse.json({ error: "Missing organization" }, { status: 400 });
    if (orgId && orgId !== user.organization_id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
      .eq("action", "export_enrollments")
      .gte("created_at", windowStartIso);
    if (!rateErr && typeof count === "number" && count >= 2) {
      return NextResponse.json(
        { error: "Rate limit: you can export Enrollments (CSV) up to 2 times per 30 minutes." },
        { status: 429 }
      );
    }
  } catch {
    // ignore rate limit failures (do not block exports)
  }

  const summary = await fetchEnrollmentTestSummary({
    organizationId: effectiveOrgId,
    courseId,
    userId,
    result,
    q,
    from,
    to,
    limit: Number.isFinite(max) ? max : 50000,
  });

  if (summary.error) {
    return NextResponse.json({ error: summary.error }, { status: 500 });
  }

  const exportRows = summary.rows.map((r) => ({
    organization_id: r.organization_id,
    organization_name: r.organization_name ?? "",
    user_id: r.user_id,
    user_email: r.user_email ?? "",
    user_full_name: r.user_full_name ?? "",
    course_id: r.course_id,
    course_title: r.course_title ?? "",
    enrolled_at: r.enrolled_at ?? "",
    result: r.course_result ?? "",
    attempts_submitted: r.submitted_count ?? 0,
    attempts_total: r.attempt_count ?? 0,
    total_time: formatDurationSeconds(r.total_duration_seconds),
    latest_time: formatDurationSeconds(r.latest_attempt_duration_seconds),
    latest_score: typeof r.latest_score === "number" ? r.latest_score : "",
  }));

  const csv = buildCsv(exportRows);
  const filename = effectiveOrgId ? `enrollments-${effectiveOrgId}.csv` : "enrollments-all.csv";

  // Best-effort audit log (do not block exports)
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: user.id,
      actor_email: user.email,
      actor_role: user.role,
      action: "export_enrollments",
      entity: effectiveOrgId ? "organizations" : "system",
      entity_id: effectiveOrgId ?? null,
      metadata: {
        organization_id: effectiveOrgId ?? null,
        export: "enrollments",
        format: "csv",
        row_count: exportRows.length,
        max: Number.isFinite(max) ? max : 50000,
        course_id: courseId ?? null,
        user_id: userId ?? null,
        result: result ?? null,
        q_present: Boolean(q && q.trim().length > 0),
        q_length: typeof q === "string" ? q.trim().length : 0,
        from: from ?? null,
        to: to ?? null,
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

