import { NextRequest } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

function isPdf(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function sanitizeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 140);
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

  // Use session client so RLS applies (members will only see enrolled resources).
  const supabase = await createServerSupabaseClient();
  const { data, error: loadError } = await supabase
    .from("course_resources")
    .select("id, created_at, course_id, title, file_name, storage_bucket, storage_path, mime_type, size_bytes")
    .eq("course_id", id)
    .order("created_at", { ascending: false });

  if (loadError) return apiError("INTERNAL", "Failed to load resources.", { status: 500 });
  return apiOk({ resources: Array.isArray(data) ? data : [] }, { status: 200 });
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

  if (caller.role !== "organization_admin") {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return apiError("VALIDATION_ERROR", "Invalid form data.", { status: 400 });

  const files = [
    ...form.getAll("files"),
    ...form.getAll("file"),
  ].filter((v): v is File => v instanceof File);

  if (files.length === 0) return apiError("VALIDATION_ERROR", "Missing file(s).", { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: courseRow, error: courseError } = await admin
    .from("courses")
    .select("id, organization_id")
    .eq("id", id)
    .single();

  if (courseError || !courseRow) {
    return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  }

  // Org admins can only manage org-owned courses
  if (!caller.organization_id || courseRow.organization_id !== caller.organization_id) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const bucket = "course-resources";
  const maxBytes = 20 * 1024 * 1024; // 20MB cap (matches SQL constraint suggestion)

  const insertedRows: unknown[] = [];
  for (const file of files) {
    if (!isPdf(file)) {
      return apiError("VALIDATION_ERROR", "Only PDF files are allowed.", { status: 400 });
    }
    if (file.size > maxBytes) {
      return apiError("VALIDATION_ERROR", "File too large (max 20MB).", { status: 400 });
    }

    const ts = Date.now();
    const safeName = sanitizeFileName(file.name || "resource.pdf");
    const path = `courses/${id}/resources/${ts}-${safeName}`;

    const bytes = await file.arrayBuffer();
    const uploadRes = await admin.storage.from(bucket).upload(path, bytes, {
      contentType: "application/pdf",
      upsert: true,
    });

    if (uploadRes.error) {
      await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Upload failed.", internalMessage: uploadRes.error.message });
      return apiError("INTERNAL", "Upload failed.", { status: 500 });
    }

    const { data: inserted, error: insertError } = await admin
      .from("course_resources")
      .insert({
        course_id: id,
        organization_id: courseRow.organization_id,
        title: null,
        file_name: file.name,
        storage_bucket: bucket,
        storage_path: path,
        mime_type: "application/pdf",
        size_bytes: file.size,
        uploaded_by: caller.id,
      })
      .select("id, created_at, title, file_name, storage_bucket, storage_path, mime_type, size_bytes")
      .single();

    if (insertError || !inserted) {
      await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to save resource.", internalMessage: insertError?.message });
      return apiError("INTERNAL", "Failed to save resource.", { status: 500 });
    }

    // Best-effort audit log
    try {
      await admin.from("audit_logs").insert({
        actor_user_id: caller.id,
        actor_email: caller.email,
        actor_role: caller.role,
        action: "upload_course_resource",
        entity: "courses",
        entity_id: id,
        metadata: { path, file_name: file.name },
      });
    } catch {
      // ignore
    }

    insertedRows.push(inserted);
  }

  await logApiEvent({ request, caller, outcome: "success", status: 201, publicMessage: "Resources uploaded.", details: { course_id: id, count: insertedRows.length } });
  return apiOk({ resources: insertedRows }, { status: 201, message: "Resources uploaded." });
}

