import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { updateTopicSchema, validateSchema } from "@/lib/validations/schemas";

export async function PATCH(request: NextRequest, context: { params: Promise<{ topicId: string }> }) {
  const { topicId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = validateSchema(updateTopicSchema, body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", parsed.error, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: topic, error: topicError } = await admin
    .from("course_topics")
    .select("id, organization_id")
    .eq("id", topicId)
    .single();
  if (topicError || !topic?.id) return apiError("NOT_FOUND", "Topic not found.", { status: 404 });
  if (topic.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: caller.id,
  };
  if (Object.prototype.hasOwnProperty.call(parsed.data, "title")) payload.title = parsed.data.title?.trim();
  if (Object.prototype.hasOwnProperty.call(parsed.data, "summary")) payload.summary = parsed.data.summary?.trim() || null;

  const { data, error: updateError } = await admin
    .from("course_topics")
    .update(payload)
    .eq("id", topicId)
    .select("id, title, summary, position, updated_at")
    .single();
  if (updateError || !data) return apiError("INTERNAL", "Failed to update topic.", { status: 500 });
  return apiOk({ topic: data }, { status: 200, message: "Topic updated." });
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ topicId: string }> }) {
  const { topicId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const admin = createAdminSupabaseClient();
  const { data: topic, error: topicError } = await admin
    .from("course_topics")
    .select("id, organization_id")
    .eq("id", topicId)
    .single();
  if (topicError || !topic?.id) return apiError("NOT_FOUND", "Topic not found.", { status: 404 });
  if (topic.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const { error: delError } = await admin.from("course_topics").delete().eq("id", topicId);
  if (delError) return apiError("INTERNAL", "Failed to delete topic.", { status: 500 });
  return apiOk({ topic_id: topicId }, { status: 200, message: "Topic deleted." });
}

