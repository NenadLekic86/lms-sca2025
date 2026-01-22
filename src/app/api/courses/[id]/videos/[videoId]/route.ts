import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string; videoId: string }> }) {
  const { id, videoId } = await context.params;
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

  if (!["super_admin", "system_admin", "organization_admin"].includes(caller.role)) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  const { data: videoRow, error: loadError } = await admin
    .from("course_videos")
    .select("id, course_id, organization_id")
    .eq("id", videoId)
    .eq("course_id", id)
    .single();

  if (loadError || !videoRow) {
    return apiError("NOT_FOUND", "Video not found.", { status: 404 });
  }

  if (caller.role === "organization_admin") {
    if (!caller.organization_id || videoRow.organization_id !== caller.organization_id) {
      await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }
  }

  const { error: delError } = await admin.from("course_videos").delete().eq("id", videoId);
  if (delError) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to delete video.", internalMessage: delError.message });
    return apiError("INTERNAL", "Failed to delete video.", { status: 500 });
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "remove_course_video",
      entity: "courses",
      entity_id: id,
      metadata: { video_id: videoId },
    });
  } catch {
    // ignore
  }

  await logApiEvent({ request, caller, outcome: "success", status: 200, publicMessage: "Video deleted.", details: { course_id: id, video_id: videoId } });
  return apiOk({ ok: true }, { status: 200, message: "Video deleted." });
}

