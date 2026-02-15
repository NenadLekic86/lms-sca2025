import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";

export const runtime = "nodejs";

async function ensureLessonAssetsBucket(admin: ReturnType<typeof createAdminSupabaseClient>) {
  const bucketId = "course-lesson-assets";
  const { data, error } = await admin.storage.getBucket(bucketId);
  if (!error && data?.id) return;
  const create = await admin.storage.createBucket(bucketId, { public: false });
  if (create.error) {
    console.error("[lesson-assets] bucket ensure failed", create.error);
  }
}

function getExtFromMime(mime: string): string {
  if (mime === "video/mp4") return "mp4";
  return "bin";
}

export async function POST(request: NextRequest, context: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const form = await request.formData().catch(() => null);
  if (!form) return apiError("VALIDATION_ERROR", "Invalid form data.", { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return apiError("VALIDATION_ERROR", "Missing video file.", { status: 400 });

  if (file.type !== "video/mp4") return apiError("VALIDATION_ERROR", "Invalid file type (allowed: MP4).", { status: 400 });
  const maxBytes = 50 * 1024 * 1024;
  if (file.size > maxBytes) return apiError("VALIDATION_ERROR", "File too large (max 50MB).", { status: 400 });

  const admin = createAdminSupabaseClient();
  await ensureLessonAssetsBucket(admin);
  const { data: item, error: itemError } = await admin
    .from("course_topic_items")
    .select("id, organization_id, course_id")
    .eq("id", itemId)
    .single();
  if (itemError || !item?.id) return apiError("NOT_FOUND", "Item not found.", { status: 404 });
  if (item.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const ext = getExtFromMime(file.type);
  const ts = Date.now();
  const path = `${caller.organization_id}/${item.course_id}/${itemId}/video-${ts}.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  const uploadRes = await admin.storage.from("course-lesson-assets").upload(path, bytes, {
    contentType: file.type,
    upsert: true,
  });
  if (uploadRes.error) {
    console.error("[lesson video upload]", {
      bucket: "course-lesson-assets",
      path,
      itemId,
      orgId: caller.organization_id,
      courseId: item.course_id,
      error: uploadRes.error,
    });
    const msg =
      process.env.NODE_ENV === "production"
        ? "Lesson video upload failed."
        : `Lesson video upload failed: ${uploadRes.error.message}`;
    return apiError("INTERNAL", msg, { status: 500 });
  }

  return apiOk({ storage_path: path }, { status: 200, message: "Lesson video uploaded." });
}

