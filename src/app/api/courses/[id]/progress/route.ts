import { NextRequest } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { validateSchema } from "@/lib/validations/schemas";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

const upsertProgressSchema = z.object({
  item_type: z.enum(["resource", "video"]),
  item_id: z.string().uuid(),
  completed: z.boolean(),
});

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({
      request,
      caller: null,
      outcome: "error",
      status: 401,
      code: "UNAUTHORIZED",
      publicMessage: "Unauthorized",
      internalMessage: typeof error === "string" ? error : "No authenticated user",
    });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  const supabase = await createServerSupabaseClient();

  const { data, error: loadError } = await supabase
    .from("course_content_progress")
    .select("id, course_id, item_type, item_id, completed_at, updated_at")
    .eq("course_id", id)
    .eq("user_id", caller.id);

  if (loadError) return apiError("INTERNAL", "Failed to load progress.", { status: 500 });

  return apiOk({ progress: Array.isArray(data) ? data : [] }, { status: 200 });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({
      request,
      caller: null,
      outcome: "error",
      status: 401,
      code: "UNAUTHORIZED",
      publicMessage: "Unauthorized",
      internalMessage: typeof error === "string" ? error : "No authenticated user",
    });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }
  if (!caller.organization_id) return apiError("VALIDATION_ERROR", "Missing organization.", { status: 400 });

  const body = await request.json().catch(() => null);
  const validation = validateSchema(upsertProgressSchema, body);
  if (!validation.success) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: validation.error });
    return apiError("VALIDATION_ERROR", validation.error, { status: 400 });
  }

  const { item_type, item_id, completed } = validation.data;

  // Use session client so RLS enforces:
  // - user can only write their own progress
  // - user must be enrolled (active) in the course
  const supabase = await createServerSupabaseClient();

  const now = new Date().toISOString();
  const completed_at = completed ? now : null;

  const { data, error: upsertError } = await supabase
    .from("course_content_progress")
    .upsert(
      {
        organization_id: caller.organization_id,
        course_id: id,
        user_id: caller.id,
        item_type,
        item_id,
        completed_at,
      },
      { onConflict: "user_id,course_id,item_type,item_id" }
    )
    .select("id, item_type, item_id, completed_at, updated_at")
    .single();

  if (upsertError || !data) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: "Failed to update progress.", internalMessage: upsertError?.message });
    return apiError("VALIDATION_ERROR", "Failed to update progress.", { status: 400 });
  }

  return apiOk({ row: data }, { status: 200, message: "Progress updated." });
}

