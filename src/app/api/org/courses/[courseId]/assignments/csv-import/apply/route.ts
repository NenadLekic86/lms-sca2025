import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiOk, readJsonBody } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { syncCourseMemberAssignments } from "@/lib/courseAssignments/syncAssignments";
import { getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

const applyCsvImportSchema = z.object({
  rows: z.array(
    z.object({
      user_id: z.string().uuid("Invalid user ID"),
      assigned: z.boolean(),
      tfa: z.enum(["unlimited", "3m", "1m", "1w"]).nullable(),
    })
  ).max(5000, "Too many rows."),
});

export async function POST(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await readJsonBody(request);
  const parsed = applyCsvImportSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request payload.", { status: 400 });
  }

  const invalidAssignedRows = parsed.data.rows.filter((row) => row.assigned && !row.tfa);
  if (invalidAssignedRows.length > 0) {
    return apiError("VALIDATION_ERROR", "Assigned rows must include TFA.", { status: 400 });
  }

  const desiredAssignments = parsed.data.rows
    .filter((row) => row.assigned && row.tfa)
    .map((row) => ({ userId: row.user_id, access: row.tfa! }));

  const syncResult = await syncCourseMemberAssignments({
    organizationId: caller.organization_id,
    courseId,
    actorUserId: caller.id,
    desiredAssignments,
  });

  if (syncResult.error || !syncResult.result) {
    if (syncResult.code === "NOT_FOUND") return apiError("NOT_FOUND", "Course not found.", { status: 404 });
    if (syncResult.code === "FORBIDDEN") return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    return apiError("INTERNAL", syncResult.error ?? "Failed to apply CSV import.", { status: 500 });
  }

  const result = syncResult.result;
  if (result.invalidUsers.length > 0) {
    return apiError("VALIDATION_ERROR", "Some rows reference users outside this organization.", { status: 400 });
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Course assignment CSV applied.",
    details: {
      course_id: courseId,
      assigned_count: result.addedCount,
      updated_count: result.updatedCount,
      removed_count: result.removedCount,
      unchanged_count: result.unchangedCount,
    },
  });

  return apiOk(
    {
      course_id: courseId,
      assigned_count: result.addedCount,
      updated_count: result.updatedCount,
      removed_count: result.removedCount,
      unchanged_count: result.unchangedCount,
    },
    { status: 200, message: "CSV import applied." }
  );
}
