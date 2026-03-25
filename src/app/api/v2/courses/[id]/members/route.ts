import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { setCourseMembersSchema, validateSchema } from "@/lib/validations/schemas";
import { type AccessDurationKey, isAccessDurationKey } from "@/lib/courseAssignments/access";
import { syncCourseMemberAssignments } from "@/lib/courseAssignments/syncAssignments";

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = validateSchema(setCourseMembersSchema, body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", parsed.error, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: course, error: courseError } = await admin
    .from("courses")
    .select("id, organization_id")
    .eq("id", id)
    .single();
  if (courseError || !course?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (course.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const desired = Array.from(new Set(parsed.data.member_ids));
  const defaultAccess: AccessDurationKey = isAccessDurationKey(parsed.data.default_access) ? parsed.data.default_access : "unlimited";
  const memberAccess = parsed.data.member_access ?? {};
  const desiredAssignments = desired.map((userId) => {
    const keyRaw = (memberAccess as Record<string, unknown>)[userId];
    const access: AccessDurationKey = isAccessDurationKey(keyRaw) ? (keyRaw as AccessDurationKey) : defaultAccess;
    return { userId, access };
  });

  const syncResult = await syncCourseMemberAssignments({
    organizationId: caller.organization_id,
    courseId: id,
    actorUserId: caller.id,
    desiredAssignments,
  });
  if (syncResult.error || !syncResult.result) {
    if (syncResult.code === "NOT_FOUND") return apiError("NOT_FOUND", "Course not found.", { status: 404 });
    if (syncResult.code === "FORBIDDEN") return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    return apiError("INTERNAL", syncResult.error ?? "Failed to update course members.", { status: 500 });
  }

  const result = syncResult.result;

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Course members updated.",
    details: {
      course_id: id,
      added_count: result.addedCount,
      updated_count: result.updatedCount,
      removed_count: result.removedCount,
      invalid_count: result.invalidUsers.length,
    },
  });

  return apiOk(
    {
      course_id: id,
      member_ids: result.validAssignments.map((row) => row.userId),
      added_count: result.addedCount,
      updated_count: result.updatedCount,
      removed_count: result.removedCount,
      invalid_users: result.invalidUsers,
    },
    { status: 200, message: "Course members updated." }
  );
}

