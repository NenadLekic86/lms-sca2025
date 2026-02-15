import { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk, readJsonBody } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

const bulkAssignmentsSchema = z.object({
  user_ids: z.array(z.string().uuid("Invalid user ID")).min(1).max(500),
  course_id: z.string().uuid("Invalid course ID"),
  action: z.enum(["assign", "remove"]),
});

type TargetUserRow = {
  id: string;
  role: string | null;
  organization_id: string | null;
  is_active: boolean | null;
};

export async function POST(request: NextRequest) {
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

  if (caller.role !== "organization_admin" || !caller.organization_id) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const body = await readJsonBody(request);
  const parsed = bulkAssignmentsSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid request payload.";
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: msg });
    return apiError("VALIDATION_ERROR", msg, { status: 400 });
  }

  const userIds = Array.from(new Set(parsed.data.user_ids));
  const { course_id: courseId, action } = parsed.data;
  const admin = createAdminSupabaseClient();

  const { data: course, error: courseError } = await admin
    .from("courses")
    .select("id, organization_id, visibility_scope, is_archived")
    .eq("id", courseId)
    .maybeSingle();

  if (courseError) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to validate course.",
      internalMessage: courseError.message,
    });
    return apiError("INTERNAL", "Failed to validate course.", { status: 500 });
  }
  if (!course?.id || course.organization_id !== caller.organization_id || course.visibility_scope !== "organizations" || course.is_archived === true) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 400,
      code: "VALIDATION_ERROR",
      publicMessage: "Selected course is invalid for this organization.",
    });
    return apiError("VALIDATION_ERROR", "Selected course is invalid for this organization.", { status: 400 });
  }

  const { data: usersData, error: usersError } = await admin
    .from("users")
    .select("id, role, organization_id, is_active")
    .in("id", userIds);

  if (usersError) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to validate selected users.",
      internalMessage: usersError.message,
    });
    return apiError("INTERNAL", "Failed to validate selected users.", { status: 500 });
  }

  const userRows = (Array.isArray(usersData) ? usersData : []) as TargetUserRow[];
  const byId = new Map(userRows.map((u) => [u.id, u]));

  const eligibleUserIds: string[] = [];
  const failures: Array<{ user_id: string; reason: string }> = [];
  for (const userId of userIds) {
    const row = byId.get(userId);
    if (!row) {
      failures.push({ user_id: userId, reason: "User not found." });
      continue;
    }
    if (row.organization_id !== caller.organization_id) {
      failures.push({ user_id: userId, reason: "User does not belong to your organization." });
      continue;
    }
    if (row.role !== "member") {
      failures.push({ user_id: userId, reason: "Only members can have course assignments." });
      continue;
    }
    if (action === "assign" && row.is_active === false) {
      failures.push({ user_id: userId, reason: "Cannot assign to disabled member." });
      continue;
    }
    eligibleUserIds.push(userId);
  }

  if (eligibleUserIds.length > 0) {
    if (action === "assign") {
      const rows = eligibleUserIds.map((userId) => ({
        organization_id: caller.organization_id,
        course_id: courseId,
        user_id: userId,
        assigned_by: caller.id,
      }));
      const { error: assignError } = await admin
        .from("course_member_assignments")
        .upsert(rows, { onConflict: "course_id,user_id" });
      if (assignError) {
        await logApiEvent({
          request,
          caller,
          outcome: "error",
          status: 500,
          code: "INTERNAL",
          publicMessage: "Failed to assign course.",
          internalMessage: assignError.message,
        });
        return apiError("INTERNAL", "Failed to assign course.", { status: 500 });
      }
    } else {
      const { error: removeError } = await admin
        .from("course_member_assignments")
        .delete()
        .eq("organization_id", caller.organization_id)
        .eq("course_id", courseId)
        .in("user_id", eligibleUserIds);
      if (removeError) {
        await logApiEvent({
          request,
          caller,
          outcome: "error",
          status: 500,
          code: "INTERNAL",
          publicMessage: "Failed to remove course assignment.",
          internalMessage: removeError.message,
        });
        return apiError("INTERNAL", "Failed to remove course assignment.", { status: 500 });
      }
    }
  }

  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: action === "assign" ? "bulk_assign_course_to_members" : "bulk_remove_course_from_members",
      entity: "courses",
      entity_id: courseId,
      metadata: {
        requested_count: userIds.length,
        success_count: eligibleUserIds.length,
        failure_count: failures.length,
      },
    });
  } catch {
    // ignore
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: action === "assign" ? "Bulk course assignment completed." : "Bulk course removal completed.",
    details: { action, course_id: courseId, requested_count: userIds.length, success_count: eligibleUserIds.length, failure_count: failures.length },
  });

  return apiOk(
    {
      action,
      course_id: courseId,
      requested_count: userIds.length,
      success_count: eligibleUserIds.length,
      failure_count: failures.length,
      failures,
    },
    {
      status: 200,
      message: action === "assign" ? "Course assigned to selected members." : "Course removed from selected members.",
    }
  );
}

