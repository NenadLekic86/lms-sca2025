import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

function getExtFromMime(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "bin";
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({
      request,
      caller: null,
      outcome: "error",
      status: 401,
      code: "UNAUTHORIZED",
      publicMessage: "Unauthorized",
      internalMessage: typeof error === "string" ? error : "No authenticated user",
    });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const download = url.searchParams.get("download") === "1";

  // Default behavior: return template metadata (used by course builder Step 4).
  if (!download) {
    // Use session client for RLS.
    const supabase = await createServerSupabaseClient();
    const { data, error: loadError } = await supabase
      .from("course_certificate_templates")
      .select("id, created_at, course_id, storage_bucket, storage_path, file_name, mime_type, size_bytes")
      .eq("course_id", id)
      .maybeSingle();

    if (loadError) return apiError("INTERNAL", "Failed to load certificate template.", { status: 500 });
    return apiOk({ template: data ?? null }, { status: 200 });
  }

  // Download behavior (v1): allow downloading the course's certificate template
  // only if the caller is authorized.
  const admin = createAdminSupabaseClient();

  if (caller.role === "member") {
    const { data: cert } = await admin
      .from("certificates")
      .select("id")
      .eq("course_id", id)
      .eq("user_id", caller.id)
      .limit(1)
      .maybeSingle();

    if (!cert?.id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  } else if (caller.role === "organization_admin") {
    if (!caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    const { data: cert } = await admin
      .from("certificates")
      .select("id")
      .eq("course_id", id)
      .eq("organization_id", caller.organization_id)
      .limit(1)
      .maybeSingle();

    if (!cert?.id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  } else if (!["super_admin", "system_admin"].includes(caller.role)) {
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const { data: tpl, error: tplError } = await admin
    .from("course_certificate_templates")
    .select("storage_bucket, storage_path")
    .eq("course_id", id)
    .maybeSingle();

  if (tplError) return apiError("INTERNAL", "Failed to load certificate template.", { status: 500 });
  if (!tpl?.storage_bucket || !tpl?.storage_path) {
    return apiError("NOT_FOUND", "Certificate template not found.", { status: 404 });
  }

  const { data: signed, error: signedError } = await admin.storage
    .from(tpl.storage_bucket)
    .createSignedUrl(tpl.storage_path, 60 * 10);

  if (signedError || !signed?.signedUrl) {
    return apiError("INTERNAL", "Failed to create signed URL.", { status: 500 });
  }

  return NextResponse.redirect(signed.signedUrl, { status: 302 });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({
      request,
      caller: null,
      outcome: "error",
      status: 401,
      code: "UNAUTHORIZED",
      publicMessage: "Unauthorized",
      internalMessage: typeof error === "string" ? error : "No authenticated user",
    });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  if (!["super_admin", "system_admin", "organization_admin"].includes(caller.role)) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return apiError("VALIDATION_ERROR", "Invalid form data.", { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File)) return apiError("VALIDATION_ERROR", "Missing file.", { status: 400 });

  const allowed = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(file.type)) {
    return apiError("VALIDATION_ERROR", "Invalid file type (allowed: PDF, PNG, JPG, WebP).", { status: 400 });
  }

  const maxBytes = 10 * 1024 * 1024;
  if (file.size > maxBytes) return apiError("VALIDATION_ERROR", "File too large (max 10MB).", { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: courseRow, error: courseError } = await admin
    .from("courses")
    .select("id, organization_id")
    .eq("id", id)
    .single();

  if (courseError || !courseRow) {
    return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  }

  if (caller.role === "organization_admin") {
    if (!caller.organization_id || courseRow.organization_id !== caller.organization_id) {
      await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }
  }

  // If an old template exists, remove best-effort after upload succeeds.
  const { data: existing } = await admin
    .from("course_certificate_templates")
    .select("id, storage_bucket, storage_path")
    .eq("course_id", id)
    .maybeSingle();

  const bucket = "certificate-templates";
  const ext = getExtFromMime(file.type);
  const ts = Date.now();
  const path = `courses/${id}/template-${ts}.${ext}`;

  const bytes = await file.arrayBuffer();
  const uploadRes = await admin.storage.from(bucket).upload(path, bytes, {
    contentType: file.type,
    upsert: true,
  });

  if (uploadRes.error) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Upload failed.", internalMessage: uploadRes.error.message });
    return apiError("INTERNAL", "Upload failed.", { status: 500 });
  }

  const { data: upserted, error: upsertError } = await admin
    .from("course_certificate_templates")
    .upsert(
      {
        course_id: id,
        organization_id: courseRow.organization_id,
        storage_bucket: bucket,
        storage_path: path,
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
        uploaded_by: caller.id,
      },
      { onConflict: "course_id" }
    )
    .select("id, created_at, course_id, storage_bucket, storage_path, file_name, mime_type, size_bytes")
    .single();

  if (upsertError || !upserted) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to save certificate template.", internalMessage: upsertError?.message });
    return apiError("INTERNAL", "Failed to save certificate template.", { status: 500 });
  }

  if (existing?.storage_bucket && existing?.storage_path) {
    try {
      await admin.storage.from(existing.storage_bucket).remove([existing.storage_path]);
    } catch {
      // ignore
    }
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "upload_certificate_template",
      entity: "courses",
      entity_id: id,
      metadata: { path, file_name: file.name },
    });
  } catch {
    // ignore
  }

  await logApiEvent({ request, caller, outcome: "success", status: 201, publicMessage: "Certificate template uploaded.", details: { course_id: id } });
  return apiOk({ template: upserted }, { status: 201, message: "Certificate template uploaded." });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({
      request,
      caller: null,
      outcome: "error",
      status: 401,
      code: "UNAUTHORIZED",
      publicMessage: "Unauthorized",
      internalMessage: typeof error === "string" ? error : "No authenticated user",
    });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  if (!["super_admin", "system_admin", "organization_admin"].includes(caller.role)) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data: row, error: loadError } = await admin
    .from("course_certificate_templates")
    .select("id, organization_id, storage_bucket, storage_path")
    .eq("course_id", id)
    .maybeSingle();

  if (loadError) return apiError("INTERNAL", "Failed to load certificate template.", { status: 500 });
  if (!row) return apiOk({ ok: true }, { status: 200 });

  if (caller.role === "organization_admin") {
    if (!caller.organization_id || row.organization_id !== caller.organization_id) {
      await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }
  }

  const { error: delError } = await admin.from("course_certificate_templates").delete().eq("course_id", id);
  if (delError) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to delete certificate template.", internalMessage: delError.message });
    return apiError("INTERNAL", "Failed to delete certificate template.", { status: 500 });
  }

  try {
    await admin.storage.from(row.storage_bucket).remove([row.storage_path]);
  } catch {
    // ignore
  }

  await logApiEvent({ request, caller, outcome: "success", status: 200, publicMessage: "Certificate template deleted.", details: { course_id: id } });
  return apiOk({ ok: true }, { status: 200, message: "Certificate template deleted." });
}

