import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError } from "@/lib/api/response";

export const runtime = "nodejs";

function isSafeStoragePath(input: string): boolean {
  if (!input.trim()) return false;
  if (input.length > 600) return false;
  if (input.includes("..")) return false;
  if (input.startsWith("/")) return false;
  return true;
}

export async function GET(request: NextRequest) {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const storagePath = url.searchParams.get("path") ?? "";
  if (!isSafeStoragePath(storagePath)) return apiError("VALIDATION_ERROR", "Invalid path.", { status: 400 });

  // Paths are stored as: orgId/courseId/itemId/(...)
  const parts = storagePath.split("/").filter(Boolean);
  if (parts.length < 3) return apiError("VALIDATION_ERROR", "Invalid path.", { status: 400 });
  const [orgId, courseId, itemId] = parts;

  const supabase = await createServerSupabaseClient();
  const { data: item, error: itemError } = await supabase
    .from("course_topic_items")
    .select("id, organization_id, course_id")
    .eq("id", itemId)
    .maybeSingle();

  if (itemError || !item?.id) return apiError("NOT_FOUND", "Asset not found.", { status: 404 });
  if (String(item.organization_id ?? "") !== String(orgId)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  if (String(item.course_id ?? "") !== String(courseId)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  // Authorization:
  const admin = createAdminSupabaseClient();
  if (caller.role === "organization_admin") {
    if (!caller.organization_id || String(caller.organization_id) !== String(orgId)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  } else if (caller.role === "member") {
    // Ensure active enrollment
    const { data: enrollment } = await supabase
      .from("course_enrollments")
      .select("id, status")
      .eq("course_id", courseId)
      .eq("user_id", caller.id)
      .maybeSingle();
    if (!enrollment?.id || enrollment.status !== "active") return apiError("FORBIDDEN", "Forbidden", { status: 403 });

    // Ensure course is published
    const { data: course } = await admin.from("courses").select("id, is_published").eq("id", courseId).maybeSingle();
    if (!course?.id || course.is_published !== true) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  } else {
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  // Signed URLs are generated with service role. Access is enforced above.
  const { data: signed, error: signedError } = await admin.storage.from("course-lesson-assets").createSignedUrl(storagePath, 60 * 10);
  if (signedError || !signed?.signedUrl) return apiError("INTERNAL", "Failed to create signed URL.", { status: 500 });

  return NextResponse.redirect(signed.signedUrl, {
    status: 302,
    headers: {
      // Keep this short; the signed URL already has its own TTL.
      "Cache-Control": "private, max-age=60",
    },
  });
}

