import { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk, readJsonBody } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

const replaceAssignmentsSchema = z.object({
  course_ids: z.array(z.string().uuid("Invalid course ID")).max(500),
});

type TargetUserRow = {
  id: string;
  role: string | null;
  organization_id: string | null;
  is_active: boolean | null;
};

type AssignmentRow = {
  course_id: string | null;
};

type ValidCourseRow = {
  id: string;
};

async function loadTargetUser(admin: ReturnType<typeof createAdminSupabaseClient>, userId: string) {
  const { data, error } = await admin
    .from("users")
    .select("id, role, organization_id, is_active")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data) return { user: null as TargetUserRow | null, error: "User not found." };
  return { user: data as TargetUserRow, error: null };
}

function dedupeCourseIds(courseIds: string[]) {
  return Array.from(new Set(courseIds));
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: userId } = await context.params;
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

  const admin = createAdminSupabaseClient();
  const target = await loadTargetUser(admin, userId);
  if (!target.user) {
    await logApiEvent({ request, caller, outcome: "error", status: 404, code: "NOT_FOUND", publicMessage: "User not found." });
    return apiError("NOT_FOUND", "User not found.", { status: 404 });
  }

  if (target.user.organization_id !== caller.organization_id) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  if (target.user.role !== "member") {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 400,
      code: "VALIDATION_ERROR",
      publicMessage: "Only members can have course assignments.",
    });
    return apiError("VALIDATION_ERROR", "Only members can have course assignments.", { status: 400 });
  }

  const { data, error: assignmentsError } = await admin
    .from("course_member_assignments")
    .select("course_id")
    .eq("organization_id", caller.organization_id)
    .eq("user_id", userId);

  if (assignmentsError) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to load course assignments.",
      internalMessage: assignmentsError.message,
    });
    return apiError("INTERNAL", "Failed to load course assignments.", { status: 500 });
  }

  const assignedCourseIds = ((Array.isArray(data) ? data : []) as AssignmentRow[])
    .map((r) => r.course_id)
    .filter((v): v is string => typeof v === "string");

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Course assignments loaded.",
    details: { user_id: userId, count: assignedCourseIds.length },
  });
  return apiOk({ user_id: userId, course_ids: assignedCourseIds }, { status: 200 });
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: userId } = await context.params;
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
  const parsed = replaceAssignmentsSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid request payload.";
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: msg });
    return apiError("VALIDATION_ERROR", msg, { status: 400 });
  }

  const desiredCourseIds = dedupeCourseIds(parsed.data.course_ids);
  const admin = createAdminSupabaseClient();

  const target = await loadTargetUser(admin, userId);
  if (!target.user) {
    await logApiEvent({ request, caller, outcome: "error", status: 404, code: "NOT_FOUND", publicMessage: "User not found." });
    return apiError("NOT_FOUND", "User not found.", { status: 404 });
  }
  if (target.user.organization_id !== caller.organization_id) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }
  if (target.user.role !== "member") {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 400,
      code: "VALIDATION_ERROR",
      publicMessage: "Only members can have course assignments.",
    });
    return apiError("VALIDATION_ERROR", "Only members can have course assignments.", { status: 400 });
  }
  if (target.user.is_active === false && desiredCourseIds.length > 0) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 400,
      code: "VALIDATION_ERROR",
      publicMessage: "Cannot assign courses to disabled user.",
    });
    return apiError("VALIDATION_ERROR", "Cannot assign courses to disabled user.", { status: 400 });
  }

  if (desiredCourseIds.length > 0) {
    const { data: validCourses, error: validCoursesError } = await admin
      .from("courses")
      .select("id")
      .eq("organization_id", caller.organization_id)
      .eq("visibility_scope", "organizations")
      .eq("is_archived", false)
      .in("id", desiredCourseIds);

    if (validCoursesError) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Failed to validate courses.",
        internalMessage: validCoursesError.message,
      });
      return apiError("INTERNAL", "Failed to validate courses.", { status: 500 });
    }

    const validSet = new Set(
      ((Array.isArray(validCourses) ? validCourses : []) as ValidCourseRow[])
        .map((c) => c.id)
        .filter((v): v is string => typeof v === "string")
    );
    const invalidRequested = desiredCourseIds.filter((id) => !validSet.has(id));
    if (invalidRequested.length > 0) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 400,
        code: "VALIDATION_ERROR",
        publicMessage: "Some selected courses are invalid for this organization.",
        details: { invalid_count: invalidRequested.length },
      });
      return apiError("VALIDATION_ERROR", "Some selected courses are invalid for this organization.", { status: 400 });
    }
  }

  const { data: existingRows, error: existingError } = await admin
    .from("course_member_assignments")
    .select("course_id")
    .eq("organization_id", caller.organization_id)
    .eq("user_id", userId);

  if (existingError) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to load existing assignments.",
      internalMessage: existingError.message,
    });
    return apiError("INTERNAL", "Failed to load existing assignments.", { status: 500 });
  }

  const existingCourseIds = ((Array.isArray(existingRows) ? existingRows : []) as AssignmentRow[])
    .map((r) => r.course_id)
    .filter((v): v is string => typeof v === "string");

  const existingSet = new Set(existingCourseIds);
  const desiredSet = new Set(desiredCourseIds);
  const toAdd = desiredCourseIds.filter((id) => !existingSet.has(id));
  const toRemove = existingCourseIds.filter((id) => !desiredSet.has(id));

  if (toAdd.length > 0) {
    const rows = toAdd.map((courseId) => ({
      organization_id: caller.organization_id,
      course_id: courseId,
      user_id: userId,
      assigned_by: caller.id,
    }));
    const { error: addError } = await admin
      .from("course_member_assignments")
      .upsert(rows, { onConflict: "course_id,user_id" });
    if (addError) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Failed to save course assignments.",
        internalMessage: addError.message,
      });
      return apiError("INTERNAL", "Failed to save course assignments.", { status: 500 });
    }
  }

  if (toRemove.length > 0) {
    const { error: removeError } = await admin
      .from("course_member_assignments")
      .delete()
      .eq("organization_id", caller.organization_id)
      .eq("user_id", userId)
      .in("course_id", toRemove);
    if (removeError) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Failed to remove course assignments.",
        internalMessage: removeError.message,
      });
      return apiError("INTERNAL", "Failed to remove course assignments.", { status: 500 });
    }
  }

  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "replace_user_course_assignments",
      entity: "users",
      entity_id: userId,
      target_user_id: userId,
      metadata: {
        added_count: toAdd.length,
        removed_count: toRemove.length,
        final_count: desiredCourseIds.length,
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
    publicMessage: "Course assignments updated.",
    details: { user_id: userId, added_count: toAdd.length, removed_count: toRemove.length },
  });

  return apiOk(
    {
      user_id: userId,
      course_ids: desiredCourseIds,
      added_count: toAdd.length,
      removed_count: toRemove.length,
    },
    { status: 200, message: "Course assignments updated." }
  );
}

