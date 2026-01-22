import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string; resourceId: string }> }) {
  const { id, resourceId } = await context.params;
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

  if (caller.role !== "organization_admin") {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  const { data: resourceRow, error: loadError } = await admin
    .from("course_resources")
    .select("id, course_id, organization_id, storage_bucket, storage_path")
    .eq("id", resourceId)
    .eq("course_id", id)
    .single();

  if (loadError || !resourceRow) {
    return apiError("NOT_FOUND", "Resource not found.", { status: 404 });
  }

  if (!caller.organization_id || resourceRow.organization_id !== caller.organization_id) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const { error: delError } = await admin.from("course_resources").delete().eq("id", resourceId);
  if (delError) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to delete resource.", internalMessage: delError.message });
    return apiError("INTERNAL", "Failed to delete resource.", { status: 500 });
  }

  // Best-effort Storage cleanup
  try {
    await admin.storage.from(resourceRow.storage_bucket).remove([resourceRow.storage_path]);
  } catch {
    // ignore
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "remove_course_resource",
      entity: "courses",
      entity_id: id,
      metadata: { resource_id: resourceId, path: resourceRow.storage_path },
    });
  } catch {
    // ignore
  }

  await logApiEvent({ request, caller, outcome: "success", status: 200, publicMessage: "Resource deleted.", details: { course_id: id, resource_id: resourceId } });
  return apiOk({ ok: true }, { status: 200, message: "Resource deleted." });
}

