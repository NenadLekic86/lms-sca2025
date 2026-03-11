import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { updateTopicItemSchema, validateSchema } from "@/lib/validations/schemas";
import { sanitizeRichHtml } from "@/lib/courses/sanitize.server";

export const runtime = "nodejs";

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
    if (k === "storage_path" && typeof v === "string" && isSafeStoragePath(v)) {
      out.add(v);
    } else {
      extractStoragePathsFromJson(v, out);
    }
  }
}

function collectLessonAssetPaths(payload: unknown): Set<string> {
  const out = new Set<string>();
  extractStoragePathsFromJson(payload, out);
  return out;
}

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
    .select("id, organization_id, payload_json")
    .eq("id", itemId)
    .single();
  if (itemError || !item?.id) return apiError("NOT_FOUND", "Item not found.", { status: 404 });
  if (item.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const shouldDiffPayload = Object.prototype.hasOwnProperty.call(parsed.data, "payload_json");
  const oldPaths = shouldDiffPayload ? collectLessonAssetPaths((item as { payload_json?: unknown }).payload_json ?? null) : new Set<string>();

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

  const newPaths = shouldDiffPayload ? collectLessonAssetPaths(payload.payload_json ?? null) : new Set<string>();

  const { data, error: updateError } = await admin
    .from("course_topic_items")
    .update(payload)
    .eq("id", itemId)
    .select("id, topic_id, item_type, title, position, payload_json, is_required, created_at, updated_at")
    .single();
  if (updateError || !data) return apiError("INTERNAL", "Failed to update item.", { status: 500 });

  if (shouldDiffPayload) {
    const removed: string[] = [];
    for (const p of oldPaths) {
      if (!newPaths.has(p)) removed.push(p);
    }
    for (const p of removed) {
      const rpc = await admin.rpc("enqueue_asset_deletion", {
        p_bucket_id: "course-lesson-assets",
        p_object_name: p,
        p_delay_seconds: 60 * 60 * 2,
        p_requested_by: caller.id,
        p_reason: "removed from item payload",
      });
      // Best-effort; don't fail request on enqueue.
      if (rpc.error) {
        // ignore
      }
    }
  }
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
    .select("id, organization_id, payload_json")
    .eq("id", itemId)
    .single();
  if (itemError || !item?.id) return apiError("NOT_FOUND", "Item not found.", { status: 404 });
  if (item.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const oldPaths = collectLessonAssetPaths((item as { payload_json?: unknown }).payload_json ?? null);
  for (const p of oldPaths) {
    const rpc = await admin.rpc("enqueue_asset_deletion", {
      p_bucket_id: "course-lesson-assets",
      p_object_name: p,
      p_delay_seconds: 60 * 60 * 2,
      p_requested_by: caller.id,
      p_reason: "item deleted",
    });
    if (rpc.error) {
      // ignore
    }
  }

  const { error: deleteError } = await admin.from("course_topic_items").delete().eq("id", itemId);
  if (deleteError) return apiError("INTERNAL", "Failed to delete item.", { status: 500 });
  return apiOk({ item_id: itemId }, { status: 200, message: "Topic item deleted." });
}

