import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

function getExtFromMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "bin";
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
  if (!(file instanceof File)) {
    return apiError("VALIDATION_ERROR", "Missing file.", { status: 400 });
  }

  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(file.type)) {
    return apiError("VALIDATION_ERROR", "Invalid file type (allowed: PNG, JPG, WebP).", { status: 400 });
  }

  const maxBytes = 5 * 1024 * 1024; // 5MB
  if (file.size > maxBytes) {
    return apiError("VALIDATION_ERROR", "File too large (max 5MB).", { status: 400 });
  }

  // Use service role for Storage upload and course update.
  const admin = createAdminSupabaseClient();

  // Ensure caller is allowed to edit this course.
  // - super/system: can edit any
  // - org admin: only courses owned by their org
  if (caller.role === "organization_admin") {
    const { data: row, error: rowError } = await admin
      .from("courses")
      .select("organization_id")
      .eq("id", id)
      .single();
    if (rowError || !row) {
      return apiError("NOT_FOUND", "Course not found.", { status: 404 });
    }
    if (!caller.organization_id || row.organization_id !== caller.organization_id) {
      await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }
  }

  const ext = getExtFromMime(file.type);
  const ts = Date.now();
  const path = `courses/${id}/cover-${ts}.${ext}`;

  const bytes = await file.arrayBuffer();
  const uploadRes = await admin.storage.from("course-covers").upload(path, bytes, {
    contentType: file.type,
    upsert: true,
  });

  if (uploadRes.error) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Upload failed.", internalMessage: uploadRes.error.message });
    return apiError("INTERNAL", "Upload failed.", { status: 500 });
  }

  const { data: publicUrlData } = admin.storage.from("course-covers").getPublicUrl(path);
  const coverUrl = publicUrlData.publicUrl;

  const { error: updateError } = await admin
    .from("courses")
    .update({ cover_image_url: coverUrl, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (updateError) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to update course cover.", internalMessage: updateError.message });
    return apiError("INTERNAL", "Failed to update course cover.", { status: 500 });
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "upload_course_cover",
      entity: "courses",
      entity_id: id,
      metadata: { path },
    });
  } catch {
    // ignore
  }

  await logApiEvent({ request, caller, outcome: "success", status: 200, publicMessage: "Cover updated.", details: { course_id: id } });
  return apiOk({ cover_image_url: coverUrl }, { status: 200, message: "Cover updated." });
}

