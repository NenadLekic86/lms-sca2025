import { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { generateSupportId } from "@/lib/support/supportId";

export const runtime = "nodejs";

const commitSchema = z.object({
  storage_path: z.string().min(1).max(600),
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  size_bytes: z.number().int().positive().max(10 * 1024 * 1024),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: courseId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = commitSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Invalid request.", { status: 400 });

  const { storage_path } = parsed.data;
  const expectedPrefix = `${caller.organization_id}/${courseId}/`;
  if (!storage_path.startsWith(expectedPrefix)) {
    return apiError("VALIDATION_ERROR", "Invalid storage path.", { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data: row, error: rowError } = await admin
    .from("courses")
    .select("id, organization_id, thumbnail_storage_path")
    .eq("id", courseId)
    .single();
  if (rowError || !row?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (String(row.organization_id ?? "") !== String(caller.organization_id)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const prevPath = typeof row.thumbnail_storage_path === "string" && row.thumbnail_storage_path.trim().length ? row.thumbnail_storage_path.trim() : null;

  const { data: publicUrlData } = admin.storage.from("course-covers").getPublicUrl(storage_path);
  const coverUrl = publicUrlData.publicUrl;

  const now = new Date().toISOString();
  const { error: updateError } = await admin
    .from("courses")
    .update({
      cover_image_url: coverUrl,
      thumbnail_storage_path: storage_path,
      updated_at: now,
    })
    .eq("id", courseId);

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
      details: { support_id: supportId, course_id: courseId },
    });
    return apiError("INTERNAL", "Failed to save thumbnail.", { status: 500, supportId });
  }

  // Best-effort cleanup (delayed): enqueue previous thumbnail object.
  if (prevPath && prevPath !== storage_path) {
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

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Thumbnail saved.",
    details: { course_id: courseId },
  });

  return apiOk(
    { cover_image_url: coverUrl, thumbnail_storage_path: storage_path },
    { status: 200, message: "Thumbnail saved." }
  );
}

