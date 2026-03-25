import { NextRequest } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { hasActiveOrganizationMembership } from "@/lib/organizations/memberships";

export const runtime = "nodejs";

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

  if (caller.role !== "member") {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const session = await createServerSupabaseClient();
  const admin = createAdminSupabaseClient();

  const { data: course, error: courseError } = await admin
    .from("courses")
    .select("id, organization_id, is_published, visibility_scope")
    .eq("id", id)
    .maybeSingle();

  if (courseError) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: "Invalid course.", internalMessage: courseError.message });
    return apiError("VALIDATION_ERROR", "Invalid course.", { status: 400 });
  }
  if (!course?.id) {
    await logApiEvent({ request, caller, outcome: "error", status: 404, code: "NOT_FOUND", publicMessage: "Course not found." });
    return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  }
  if (!course.is_published) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "This course is not published yet." });
    return apiError("FORBIDDEN", "This course is not published yet.", { status: 403 });
  }

  const courseOrgId = typeof course.organization_id === "string" ? course.organization_id : null;
  if (!courseOrgId) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: "Course is missing an organization." });
    return apiError("VALIDATION_ERROR", "Course is missing an organization.", { status: 400 });
  }

  const membershipCheck = await hasActiveOrganizationMembership(caller.id, courseOrgId, ["member"]);
  if (membershipCheck.error) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to validate organization access.",
      internalMessage: membershipCheck.error,
    });
    return apiError("INTERNAL", "Failed to validate organization access.", { status: 500 });
  }
  if (!membershipCheck.hasMembership) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  // Members must be explicitly assigned to the course by org admin.
  const { data: assignment, error: assignmentError } = await admin
    .from("course_member_assignments")
    .select("id, access_expires_at")
    .eq("organization_id", courseOrgId)
    .eq("course_id", id)
    .eq("user_id", caller.id)
    .maybeSingle();
  if (assignmentError) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to validate course access.",
      internalMessage: assignmentError.message,
    });
    return apiError("INTERNAL", "Failed to validate course access.", { status: 500 });
  }
  if (!assignment?.id) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 403,
      code: "FORBIDDEN",
      publicMessage: "You are not assigned to this course.",
    });
    return apiError("FORBIDDEN", "You are not assigned to this course.", { status: 403 });
  }
  const expiresAtIso = (assignment as { access_expires_at?: string | null } | null)?.access_expires_at ?? null;
  if (expiresAtIso) {
    const expiresAtMs = new Date(expiresAtIso).getTime();
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 403,
        code: "FORBIDDEN",
        publicMessage: "Your access to this course has expired.",
        details: { course_id: id, access_expires_at: expiresAtIso },
      });
      return apiError("FORBIDDEN", "Your access to this course has expired.", { status: 403 });
    }
  }

  // Already enrolled? (idempotent)
  const { data: existing } = await session
    .from("course_enrollments")
    .select("id, status, enrolled_at")
    .eq("course_id", id)
    .eq("user_id", caller.id)
    .maybeSingle();

  if (existing?.id) {
    await logApiEvent({ request, caller, outcome: "success", status: 200, publicMessage: "Already enrolled.", details: { course_id: id } });
    return apiOk({ enrollment: existing }, { status: 200, message: "Already enrolled." });
  }

  // Insert with the MEMBER session so RLS is enforced by `enrollments_member_insert_self`.
  const { data: inserted, error: insError } = await session
    .from("course_enrollments")
    .insert({
      organization_id: courseOrgId,
      course_id: id,
      user_id: caller.id,
      status: "active",
    })
    .select("id, status, enrolled_at")
    .single();

  if (insError || !inserted) {
    // Unique constraint race or already enrolled → treat as ok.
    if ((insError as { code?: string } | null)?.code === "23505") {
      const { data: row } = await session
        .from("course_enrollments")
        .select("id, status, enrolled_at")
        .eq("course_id", id)
        .eq("user_id", caller.id)
        .maybeSingle();
      if (row?.id) {
        await logApiEvent({ request, caller, outcome: "success", status: 200, publicMessage: "Already enrolled.", details: { course_id: id } });
        return apiOk({ enrollment: row }, { status: 200, message: "Already enrolled." });
      }
    }

    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: "Failed to enroll.", internalMessage: insError?.message });
    return apiError("VALIDATION_ERROR", "Failed to enroll.", { status: 400 });
  }

  await logApiEvent({ request, caller, outcome: "success", status: 201, publicMessage: "Enrollment started.", details: { course_id: id } });
  return apiOk({ enrollment: inserted }, { status: 201, message: "Enrollment started." });
}

