import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { updateTopicItemSchema, validateSchema } from "@/lib/validations/schemas";
import { sanitizeRichHtml } from "@/lib/courses/v2";

export async function PATCH(request: NextRequest, context: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = validateSchema(updateTopicItemSchema, body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", parsed.error, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: item, error: itemError } = await admin
    .from("course_topic_items")
    .select("id, organization_id")
    .eq("id", itemId)
    .single();
  if (itemError || !item?.id) return apiError("NOT_FOUND", "Item not found.", { status: 404 });
  if (item.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: caller.id,
  };
  if (Object.prototype.hasOwnProperty.call(parsed.data, "title")) payload.title = parsed.data.title?.trim() || null;
  if (Object.prototype.hasOwnProperty.call(parsed.data, "is_required")) payload.is_required = parsed.data.is_required;
  if (Object.prototype.hasOwnProperty.call(parsed.data, "payload_json")) {
    const bodyPayload = parsed.data.payload_json ?? {};
    if (typeof bodyPayload.content_html === "string") bodyPayload.content_html = sanitizeRichHtml(bodyPayload.content_html);
    if (typeof bodyPayload.summary === "string") bodyPayload.summary = sanitizeRichHtml(bodyPayload.summary);
    payload.payload_json = bodyPayload;
  }

  const { data, error: updateError } = await admin
    .from("course_topic_items")
    .update(payload)
    .eq("id", itemId)
    .select("id, topic_id, item_type, title, position, payload_json, is_required, created_at, updated_at")
    .single();
  if (updateError || !data) return apiError("INTERNAL", "Failed to update item.", { status: 500 });
  return apiOk({ item: data }, { status: 200, message: "Topic item updated." });
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const admin = createAdminSupabaseClient();
  const { data: item, error: itemError } = await admin
    .from("course_topic_items")
    .select("id, organization_id")
    .eq("id", itemId)
    .single();
  if (itemError || !item?.id) return apiError("NOT_FOUND", "Item not found.", { status: 404 });
  if (item.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const { error: deleteError } = await admin.from("course_topic_items").delete().eq("id", itemId);
  if (deleteError) return apiError("INTERNAL", "Failed to delete item.", { status: 500 });
  return apiOk({ item_id: itemId }, { status: 200, message: "Topic item deleted." });
}

