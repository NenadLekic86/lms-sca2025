import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { generateSupportId } from "@/lib/support/supportId";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const admin = createAdminSupabaseClient();
  const { data: row, error: rowError } = await admin
    .from("courses")
    .select("id, organization_id, status, is_published")
    .eq("id", id)
    .single();
  if (rowError || !row?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (row.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const { error: updateError } = await admin
    .from("courses")
    .update({
      updated_at: new Date().toISOString(),
      builder_version: 2,
    })
    .eq("id", id);

  if (updateError) {
    const supportId = generateSupportId();
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to save course.",
      internalMessage: updateError.message,
      details: { support_id: supportId },
    });
    return apiError("INTERNAL", "Failed to save course.", { status: 500, supportId });
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Course saved.",
    details: { course_id: id },
  });
  return apiOk(
    {
      status: row.status,
      is_published: row.is_published,
    },
    { status: 200, message: "Course saved." }
  );
}

