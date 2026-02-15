import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { reorderTopicsSchema, validateSchema } from "@/lib/validations/schemas";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = validateSchema(reorderTopicsSchema, body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", parsed.error, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: course, error: courseError } = await admin
    .from("courses")
    .select("id, organization_id")
    .eq("id", id)
    .single();
  if (courseError || !course?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (course.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const orderedIds = parsed.data.ordered_topic_ids;
  const { data: existing, error: existingError } = await admin
    .from("course_topics")
    .select("id")
    .eq("course_id", id);
  if (existingError) return apiError("INTERNAL", "Failed to reorder topics.", { status: 500 });

  const existingIds = new Set((Array.isArray(existing) ? existing : []).map((r) => r.id));
  if (orderedIds.length !== existingIds.size || orderedIds.some((topicId) => !existingIds.has(topicId))) {
    return apiError("VALIDATION_ERROR", "Invalid topic ordering payload.", { status: 400 });
  }

  const { error: reorderError } = await admin.rpc("v2_reorder_course_topics", {
    p_course_id: id,
    p_org_id: caller.organization_id,
    p_ordered_topic_ids: orderedIds,
    p_actor_id: caller.id,
  });
  if (reorderError) return apiError("INTERNAL", "Failed to reorder topics.", { status: 500 });

  return apiOk({ ordered_topic_ids: orderedIds }, { status: 200, message: "Topics reordered." });
}

