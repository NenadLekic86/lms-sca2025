import { NextRequest } from "next/server";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { createCourseSchema, validateSchema } from "@/lib/validations/schemas";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

type CreatedCourse = { id: string };

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

  if (caller.role !== "organization_admin") {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const validation = validateSchema(createCourseSchema, body);
  if (!validation.success) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: validation.error });
    return apiError("VALIDATION_ERROR", validation.error, { status: 400 });
  }

  const { title, description, excerpt } = validation.data;

  const supabase = await createServerSupabaseClient();

  const now = new Date().toISOString();

  if (!caller.organization_id) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 403,
      code: "FORBIDDEN",
      publicMessage: "Forbidden",
      internalMessage: "org admin missing organization_id",
    });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const insertPayload: Record<string, unknown> = {
    title,
    description,
    excerpt,
    created_by: caller.id,
    is_published: false,
    created_at: now,
    updated_at: now,
    organization_id: caller.organization_id,
    visibility_scope: "organizations",
  };

  const { data: inserted, error: insertError } = await supabase
    .from("courses")
    .insert(insertPayload)
    .select("id")
    .single();

  if (insertError || !inserted) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to create course.",
      internalMessage: insertError?.message,
    });
    return apiError("INTERNAL", "Failed to create course.", { status: 500 });
  }

  const created = inserted as CreatedCourse;

  // Best-effort audit log
  try {
    await supabase.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "create_course",
      entity: "courses",
      entity_id: created.id,
      metadata: {
        visibility_scope: "organizations",
        organization_id: caller.organization_id,
      },
    });
  } catch {
    // ignore
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 201,
    publicMessage: "Course created.",
    details: { course_id: created.id },
  });

  return apiOk({ course_id: created.id }, { status: 201, message: "Course created." });
}

