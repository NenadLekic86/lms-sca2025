import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { updateTopicSchema, validateSchema } from "@/lib/validations/schemas";

function isSafeStoragePath(input: string): boolean {
  if (!input.trim()) return false;
  if (input.length > 600) return false;
  if (input.includes("..")) return false;
  if (input.startsWith("/")) return false;
  return true;
}

function extractStoragePathsFromText(htmlOrText: string, out: Set<string>) {
  const re = /\/api\/v2\/(?:lesson-assets|course-assets)\?path=([^"'&\s>]+)/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(htmlOrText))) {
    const raw = m[1] ?? "";
    if (!raw) continue;
    try {
      const decoded = decodeURIComponent(raw);
      if (isSafeStoragePath(decoded)) out.add(decoded);
    } catch {
      // ignore
    }
  }
}

function extractStoragePathsFromJson(value: unknown, out: Set<string>) {
  if (!value) return;
  if (typeof value === "string") {
    extractStoragePathsFromText(value, out);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) extractStoragePathsFromJson(v, out);
    return;
  }
  if (typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "storage_path" && typeof v === "string" && isSafeStoragePath(v)) out.add(v);
    else extractStoragePathsFromJson(v, out);
  }
}

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

  // Best-effort cleanup (delayed): enqueue lesson assets for all items under this topic before deleting.
  const { data: items } = await admin
    .from("course_topic_items")
    .select("id, payload_json")
    .eq("topic_id", topicId);
  const paths = new Set<string>();
  for (const row of Array.isArray(items) ? items : []) {
    extractStoragePathsFromJson((row as { payload_json?: unknown }).payload_json ?? null, paths);
  }
  for (const p of paths) {
    const rpc = await admin.rpc("enqueue_asset_deletion", {
      p_bucket_id: "course-lesson-assets",
      p_object_name: p,
      p_delay_seconds: 60 * 60 * 2,
      p_requested_by: caller.id,
      p_reason: "topic deleted",
    });
    if (rpc.error) {
      // ignore
    }
  }

  // Delete items first, then topic (avoid depending on FK cascade behavior).
  const { error: itemsDelError } = await admin.from("course_topic_items").delete().eq("topic_id", topicId);
  if (itemsDelError) return apiError("INTERNAL", "Failed to delete topic items.", { status: 500 });

  const { error: delError } = await admin.from("course_topics").delete().eq("id", topicId);
  if (delError) return apiError("INTERNAL", "Failed to delete topic.", { status: 500 });
  return apiOk({ topic_id: topicId }, { status: 200, message: "Topic deleted." });
}

