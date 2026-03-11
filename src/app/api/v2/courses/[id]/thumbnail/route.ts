import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { generateSupportId } from "@/lib/support/supportId";

function getExtFromMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "bin";
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

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

  const maxBytes = 10 * 1024 * 1024; // 10MB
  if (file.size > maxBytes) {
    return apiError("VALIDATION_ERROR", "File too large (max 10MB).", { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data: row, error: rowError } = await admin
    .from("courses")
    .select("organization_id, thumbnail_storage_path")
    .eq("id", id)
    .single();
  if (rowError || !row) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (row.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const prevPath = typeof row.thumbnail_storage_path === "string" && row.thumbnail_storage_path.trim().length ? row.thumbnail_storage_path.trim() : null;

  const ext = getExtFromMime(file.type);
  const ts = Date.now();
  const path = `${caller.organization_id}/${id}/thumbnail-${ts}.${ext}`;
  const bytes = await file.arrayBuffer();

  const uploadRes = await admin.storage.from("course-covers").upload(path, bytes, {
    contentType: file.type,
    upsert: true,
  });
  if (uploadRes.error) {
    const supportId = generateSupportId();
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Thumbnail upload failed.",
      internalMessage: uploadRes.error.message,
      details: { support_id: supportId, course_id: id },
    });
    return apiError("INTERNAL", "Thumbnail upload failed.", { status: 500, supportId });
  }

  const { data: publicUrlData } = admin.storage.from("course-covers").getPublicUrl(path);
  const coverUrl = publicUrlData.publicUrl;

  const { error: updateError } = await admin
    .from("courses")
    .update({
      cover_image_url: coverUrl,
      thumbnail_storage_path: path,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateError) {
    const supportId = generateSupportId();
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to save thumbnail.",
      internalMessage: updateError.message,
      details: { support_id: supportId, course_id: id },
    });
    return apiError("INTERNAL", "Failed to save thumbnail.", { status: 500, supportId });
  }

  // Best-effort cleanup (delayed): enqueue previous thumbnail object.
  if (prevPath && prevPath !== path) {
    const rpc = await admin.rpc("enqueue_asset_deletion", {
      p_bucket_id: "course-covers",
      p_object_name: prevPath,
      p_delay_seconds: 60 * 60 * 2,
      p_requested_by: caller.id,
      p_reason: "replaced thumbnail",
    });
    if (rpc.error) {
      // ignore
    }
  }

  return apiOk(
    { cover_image_url: coverUrl, thumbnail_storage_path: path },
    { status: 200, message: "Thumbnail saved." }
  );
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({ request, caller: null, outcome: "error", status: 401, code: "UNAUTHORIZED", publicMessage: "Unauthorized" });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }
  if (caller.role !== "organization_admin" || !caller.organization_id) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data: row, error: rowError } = await admin
    .from("courses")
    .select("organization_id, thumbnail_storage_path")
    .eq("id", id)
    .single();
  if (rowError || !row) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (row.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const storagePath = typeof row.thumbnail_storage_path === "string" && row.thumbnail_storage_path.trim().length > 0 ? row.thumbnail_storage_path.trim() : null;

  // Best-effort cleanup (delayed): enqueue old object instead of deleting immediately (avoid breaking signed/public URLs mid-session).
  if (storagePath) {
    const rpc = await admin.rpc("enqueue_asset_deletion", {
      p_bucket_id: "course-covers",
      p_object_name: storagePath,
      p_delay_seconds: 60 * 60 * 2,
      p_requested_by: caller.id,
      p_reason: "thumbnail removed",
    });
    if (rpc.error) {
      const supportId = generateSupportId();
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Thumbnail removal enqueue failed.",
        internalMessage: rpc.error.message,
        details: { support_id: supportId, course_id: id, storage_path: storagePath },
      });
      // Continue; we still want to clear DB fields to hide the thumbnail in the app.
    }
  }

  const { error: updateError } = await admin
    .from("courses")
    .update({
      cover_image_url: null,
      thumbnail_storage_path: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateError) {
    const supportId = generateSupportId();
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to remove thumbnail.",
      internalMessage: updateError.message,
      details: { support_id: supportId, course_id: id },
    });
    return apiError("INTERNAL", "Failed to remove thumbnail.", { status: 500, supportId });
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    code: "OK",
    publicMessage: "Thumbnail removed.",
  });

  return apiOk({ cover_image_url: null, thumbnail_storage_path: null }, { status: 200, message: "Thumbnail removed." });
}

