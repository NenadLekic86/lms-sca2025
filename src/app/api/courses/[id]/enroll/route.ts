import { NextRequest } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

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

  // Derive org id the same way your RLS policies do (often via `current_user_org()`).
  const { data: orgIdRaw } = await session.rpc("current_user_org");
  const orgId = typeof orgIdRaw === "string" ? orgIdRaw : caller.organization_id;
  if (!orgId) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: "Missing organization." });
    return apiError("VALIDATION_ERROR", "Missing organization.", { status: 400 });
  }

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

  // Org-only courses: allow enroll only for courses owned by the caller's org.
  const isOrgOwned = course.organization_id === orgId;
  if (!isOrgOwned) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
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
      organization_id: orgId,
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

