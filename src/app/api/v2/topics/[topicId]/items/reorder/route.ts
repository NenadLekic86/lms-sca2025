import { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { validateSchema } from "@/lib/validations/schemas";

const reorderItemsSchema = z.object({
  ordered_item_ids: z.array(z.string().uuid("Invalid item ID")).min(1, "No items to reorder"),
});

export async function POST(request: NextRequest, context: { params: Promise<{ topicId: string }> }) {
  const { topicId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = validateSchema(reorderItemsSchema, body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", parsed.error, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: topic, error: topicError } = await admin
    .from("course_topics")
    .select("id, organization_id")
    .eq("id", topicId)
    .single();
  if (topicError || !topic?.id) return apiError("NOT_FOUND", "Topic not found.", { status: 404 });
  if (topic.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const { data: existing, error: existingError } = await admin
    .from("course_topic_items")
    .select("id")
    .eq("topic_id", topicId);
  if (existingError) return apiError("INTERNAL", "Failed to reorder items.", { status: 500 });

  const ids = parsed.data.ordered_item_ids;
  const existingIds = new Set((Array.isArray(existing) ? existing : []).map((r) => r.id));
  if (ids.length !== existingIds.size || ids.some((itemId) => !existingIds.has(itemId))) {
    return apiError("VALIDATION_ERROR", "Invalid item ordering payload.", { status: 400 });
  }

  const { error: reorderError } = await admin.rpc("v2_reorder_topic_items", {
    p_topic_id: topicId,
    p_org_id: caller.organization_id,
    p_ordered_item_ids: ids,
    p_actor_id: caller.id,
  });
  if (reorderError) return apiError("INTERNAL", "Failed to reorder items.", { status: 500 });

  return apiOk({ ordered_item_ids: ids }, { status: 200, message: "Items reordered." });
}

