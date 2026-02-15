import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
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

  const parts = storagePath.split("/").filter(Boolean);
  if (parts.length < 2) return apiError("VALIDATION_ERROR", "Invalid path.", { status: 400 });
  const [orgId, courseId] = parts;

  const admin = createAdminSupabaseClient();
  const { data: course, error: courseError } = await admin.from("courses").select("id, organization_id, is_published").eq("id", courseId).maybeSingle();
  if (courseError || !course?.id) return apiError("NOT_FOUND", "Asset not found.", { status: 404 });
  if (String(course.organization_id ?? "") !== String(orgId)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  if (caller.role === "organization_admin") {
    if (!caller.organization_id || String(caller.organization_id) !== String(orgId)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  } else if (caller.role === "member") {
    // About-course assets should be readable before enrollment, but only for published courses in the member's org.
    if (!caller.organization_id || String(caller.organization_id) !== String(orgId)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    if (course.is_published !== true) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  } else {
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const { data: signed, error: signedError } = await admin.storage.from("course-lesson-assets").createSignedUrl(storagePath, 60 * 10);
  if (signedError || !signed?.signedUrl) return apiError("INTERNAL", "Failed to create signed URL.", { status: 500 });

  return NextResponse.redirect(signed.signedUrl, {
    status: 302,
    headers: {
      "Cache-Control": "private, max-age=60",
    },
  });
}

