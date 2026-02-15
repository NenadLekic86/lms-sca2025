import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";

export const runtime = "nodejs";

async function ensureLessonAssetsBucket(admin: ReturnType<typeof createAdminSupabaseClient>) {
  const bucketId = "course-lesson-assets";
  const { data, error } = await admin.storage.getBucket(bucketId);
  if (!error && data?.id) return;
  const create = await admin.storage.createBucket(bucketId, { public: false });
  if (create.error) console.error("[lesson-assets] bucket ensure failed", create.error);
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || "inline-image";
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const form = await request.formData().catch(() => null);
  if (!form) return apiError("VALIDATION_ERROR", "Invalid form data.", { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return apiError("VALIDATION_ERROR", "Missing image file.", { status: 400 });
  const uploadId = typeof form.get("upload_id") === "string" ? String(form.get("upload_id")) : null;

  const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  if (!allowed.has(file.type)) return apiError("VALIDATION_ERROR", "Invalid file type (allowed: PNG, JPG, WebP, GIF).", { status: 400 });
  const maxBytes = 10 * 1024 * 1024;
  if (file.size > maxBytes) return apiError("VALIDATION_ERROR", "File too large (max 10MB).", { status: 400 });

  const admin = createAdminSupabaseClient();
  await ensureLessonAssetsBucket(admin);

  const { data: course, error: courseError } = await admin.from("courses").select("id, organization_id").eq("id", id).single();
  if (courseError || !course?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (String(course.organization_id) !== String(caller.organization_id)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const ts = Date.now();
  const name = safeFileName(file.name);
  const path = `${caller.organization_id}/${id}/course/inline-images/${ts}-${name}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  const uploadRes = await admin.storage.from("course-lesson-assets").upload(path, bytes, { contentType: file.type, upsert: true });
  if (uploadRes.error) {
    console.error("[course inline-image upload]", { bucket: "course-lesson-assets", path, courseId: id, orgId: caller.organization_id, error: uploadRes.error });
    const msg = process.env.NODE_ENV === "production" ? "Inline image upload failed." : `Inline image upload failed: ${uploadRes.error.message}`;
    return apiError("INTERNAL", msg, { status: 500 });
  }

  return apiOk({ storage_path: path, upload_id: uploadId, file_name: file.name, size_bytes: file.size, mime: file.type }, { status: 200 });
}

