import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";

export const runtime = "nodejs";

async function ensureLessonAssetsBucket(admin: ReturnType<typeof createAdminSupabaseClient>) {
  const bucketId = "course-lesson-assets";
  const { data, error } = await admin.storage.getBucket(bucketId);
  if (!error && data?.id) return;
  // Most common: bucket not created yet in this Supabase project.
  const create = await admin.storage.createBucket(bucketId, { public: false });
  if (create.error) {
    // If bucket already exists or creation is forbidden, we continue and let upload return a clearer error.
    console.error("[lesson-assets] bucket ensure failed", create.error);
  }
}

function getExtFromMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
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
  if (!(file instanceof File)) return apiError("VALIDATION_ERROR", "Missing image file.", { status: 400 });

  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(file.type)) return apiError("VALIDATION_ERROR", "Invalid file type (allowed: PNG, JPG, WebP).", { status: 400 });
  const maxBytes = 10 * 1024 * 1024;
  if (file.size > maxBytes) return apiError("VALIDATION_ERROR", "File too large (max 10MB).", { status: 400 });

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
  const path = `${caller.organization_id}/${item.course_id}/${itemId}/feature-${ts}.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  const uploadRes = await admin.storage.from("course-lesson-assets").upload(path, bytes, {
    contentType: file.type,
    upsert: true,
  });
  if (uploadRes.error) {
    console.error("[lesson feature-image upload]", {
      bucket: "course-lesson-assets",
      path,
      itemId,
      orgId: caller.organization_id,
      courseId: item.course_id,
      error: uploadRes.error,
    });
    const msg =
      process.env.NODE_ENV === "production"
        ? "Feature image upload failed."
        : `Feature image upload failed: ${uploadRes.error.message}`;
    return apiError("INTERNAL", msg, { status: 500 });
  }

  return apiOk({ storage_path: path }, { status: 200, message: "Feature image uploaded." });
}

