import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

const placementSchema = z
  .object({
    page: z.number().int().min(1),
    xPct: z.number().min(0).max(1),
    yPct: z.number().min(0).max(1),
    wPct: z.number().min(0).max(1).optional(),
    hPct: z.number().min(0).max(1).optional(),
    fontSize: z.number().min(6).max(200).optional(),
    color: z.string().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
  })
  .strict();

const upsertSchema = z
  .object({
    enabled: z.boolean().optional(),
    certificate_title: z.string().max(2000).optional(),
    course_passing_grade_percent: z.number().int().min(0).max(100).optional(),
    name_placement_json: placementSchema.nullable().optional(),
  })
  .strict();

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: courseId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({ request, caller: null, outcome: "error", status: 401, code: "UNAUTHORIZED", publicMessage: "Unauthorized" });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  const supabase = await createServerSupabaseClient();

  const [{ data: settings, error: sErr }, { data: tpl, error: tErr }] = await Promise.all([
    supabase
      .from("course_certificate_settings")
      .select("course_id, organization_id, enabled, certificate_title, course_passing_grade_percent, name_placement_json, updated_at, updated_by")
      .eq("course_id", courseId)
      .maybeSingle(),
    supabase
      .from("course_certificate_templates")
      .select("id, created_at, course_id, storage_bucket, storage_path, file_name, mime_type, size_bytes")
      .eq("course_id", courseId)
      .maybeSingle(),
  ]);

  if (sErr) return apiError("INTERNAL", "Failed to load certificate settings.", { status: 500 });
  if (tErr) return apiError("INTERNAL", "Failed to load certificate template.", { status: 500 });

  return apiOk({ settings: settings ?? null, template: tpl ?? null }, { status: 200 });
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: courseId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({ request, caller: null, outcome: "error", status: 401, code: "UNAUTHORIZED", publicMessage: "Unauthorized" });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  if (!["organization_admin", "super_admin", "system_admin"].includes(caller.role)) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Invalid request.", { status: 400 });

  const admin = createAdminSupabaseClient();

  // Authoritative org ownership check
  const { data: courseRow, error: courseErr } = await admin.from("courses").select("id, organization_id").eq("id", courseId).single();
  if (courseErr || !courseRow?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });

  const orgId = typeof courseRow.organization_id === "string" ? courseRow.organization_id : null;
  if (!orgId) return apiError("VALIDATION_ERROR", "Course has no organization.", { status: 400 });

  if (caller.role === "organization_admin") {
    if (!caller.organization_id || caller.organization_id !== orgId) {
      await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }
  }

  const payload = parsed.data;
  const update: Record<string, unknown> = {
    course_id: courseId,
    organization_id: orgId,
    updated_at: new Date().toISOString(),
    updated_by: caller.id,
  };
  if (typeof payload.enabled === "boolean") update.enabled = payload.enabled;
  if (typeof payload.certificate_title === "string") update.certificate_title = payload.certificate_title;
  if (typeof payload.course_passing_grade_percent === "number") update.course_passing_grade_percent = payload.course_passing_grade_percent;
  if (payload.name_placement_json !== undefined) update.name_placement_json = payload.name_placement_json;

  const { data: upserted, error: upsertErr } = await admin
    .from("course_certificate_settings")
    .upsert(update, { onConflict: "course_id" })
    .select("course_id, organization_id, enabled, certificate_title, course_passing_grade_percent, name_placement_json, updated_at, updated_by")
    .single();

  if (upsertErr || !upserted) return apiError("INTERNAL", "Failed to save certificate settings.", { status: 500 });

  await logApiEvent({ request, caller, outcome: "success", status: 200, publicMessage: "Certificate settings saved.", details: { course_id: courseId } });
  return apiOk({ settings: upserted }, { status: 200, message: "Certificate settings saved." });
}

