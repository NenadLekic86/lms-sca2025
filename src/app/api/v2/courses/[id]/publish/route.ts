import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { hasMeaningfulHtmlContent } from "@/lib/courses/v2";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const admin = createAdminSupabaseClient();
  const { data: row, error: rowError } = await admin
    .from("courses")
    .select("id, organization_id, title, slug, about_html, builder_version")
    .eq("id", id)
    .single();
  if (rowError || !row?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (row.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  if (!row.title || row.title.trim().length < 2) {
    return apiError("VALIDATION_ERROR", "Cannot publish: title is required.", { status: 400 });
  }
  if (!row.slug || row.slug.trim().length < 2) {
    return apiError("VALIDATION_ERROR", "Cannot publish: permalink slug is required.", { status: 400 });
  }
  if (!hasMeaningfulHtmlContent(row.about_html)) {
    return apiError("VALIDATION_ERROR", "Cannot publish: About Course content is required.", { status: 400 });
  }

  const { count: topicCount, error: topicCountError } = await admin
    .from("course_topics")
    .select("id", { count: "exact", head: true })
    .eq("course_id", id);

  if (topicCountError) {
    return apiError("INTERNAL", "Cannot validate topics.", { status: 500 });
  }
  if ((topicCount ?? 0) < 1) {
    return apiError("VALIDATION_ERROR", "Cannot publish: add at least one topic in Course Builder.", { status: 400 });
  }

  const { error: updateError } = await admin
    .from("courses")
    .update({
      status: "published",
      is_published: true,
      builder_version: 2,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateError) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to publish course.",
      internalMessage: updateError.message,
    });
    return apiError("INTERNAL", "Failed to publish course.", { status: 500 });
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Course published.",
    details: { course_id: id },
  });
  return apiOk({ status: "published" }, { status: 200, message: "Course published." });
}

