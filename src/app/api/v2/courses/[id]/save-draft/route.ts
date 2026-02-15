import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const admin = createAdminSupabaseClient();
  const { data: row, error: rowError } = await admin
    .from("courses")
    .select("id, organization_id")
    .eq("id", id)
    .single();
  if (rowError || !row?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (row.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const { error: updateError } = await admin
    .from("courses")
    .update({
      status: "draft",
      is_published: false,
      updated_at: new Date().toISOString(),
      builder_version: 2,
    })
    .eq("id", id);

  if (updateError) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to save draft.",
      internalMessage: updateError.message,
    });
    return apiError("INTERNAL", "Failed to save draft.", { status: 500 });
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Draft saved.",
    details: { course_id: id },
  });
  return apiOk({ status: "draft" }, { status: 200, message: "Draft saved." });
}

