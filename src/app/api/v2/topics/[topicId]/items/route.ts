import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { createTopicItemSchema, validateSchema } from "@/lib/validations/schemas";
import { sanitizeRichHtml } from "@/lib/courses/v2";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ topicId: string }> }) {
  const { topicId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = validateSchema(createTopicItemSchema, body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", parsed.error, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: topic, error: topicError } = await admin
    .from("course_topics")
    .select("id, organization_id, course_id")
    .eq("id", topicId)
    .single();
  if (topicError || !topic?.id) return apiError("NOT_FOUND", "Topic not found.", { status: 404 });
  if (topic.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const { count, error: countError } = await admin
    .from("course_topic_items")
    .select("id", { head: true, count: "exact" })
    .eq("topic_id", topicId);
  if (countError) return apiError("INTERNAL", "Failed to create item.", { status: 500 });

  const payload = parsed.data.payload_json ?? {};
  // Sanitize expected rich text fields if present.
  if (typeof payload.content_html === "string") payload.content_html = sanitizeRichHtml(payload.content_html);
  if (typeof payload.summary === "string") payload.summary = sanitizeRichHtml(payload.summary);

  const { data, error: insertError } = await admin
    .from("course_topic_items")
    .insert({
      topic_id: topicId,
      course_id: topic.course_id,
      organization_id: topic.organization_id,
      item_type: parsed.data.item_type,
      title: parsed.data.title?.trim() || null,
      payload_json: payload,
      position: count ?? 0,
      created_by: caller.id,
      updated_by: caller.id,
    })
    .select("id, topic_id, item_type, title, position, payload_json, is_required, created_at, updated_at")
    .single();

  if (insertError || !data) return apiError("INTERNAL", "Failed to create item.", { status: 500 });
  return apiOk({ item: data }, { status: 201, message: "Topic item created." });
}

