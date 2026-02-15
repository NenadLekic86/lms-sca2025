import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { createCourseV2Schema, validateSchema } from "@/lib/validations/schemas";
import { ensureUniqueCourseSlug } from "@/lib/courses/v2";

type CreatedCourse = { id: string; slug: string; status: "draft" | "published" };

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

  const body = await request.json().catch(() => null);
  const parsed = validateSchema(createCourseV2Schema, body);
  if (!parsed.success) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: parsed.error });
    return apiError("VALIDATION_ERROR", parsed.error, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const now = new Date().toISOString();
  const title = parsed.data.title.trim();

  let slug: string;
  try {
    slug = await ensureUniqueCourseSlug({
      organizationId: caller.organization_id,
      titleOrSlug: title,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to prepare slug";
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to create course.", internalMessage: msg });
    return apiError("INTERNAL", "Failed to create course.", { status: 500 });
  }

  const { data, error: insertError } = await admin
    .from("courses")
    .insert({
      title,
      slug,
      status: "draft",
      is_published: false,
      organization_id: caller.organization_id,
      visibility_scope: "organizations",
      difficulty_level: "all_levels",
      builder_version: 2,
      created_by: caller.id,
      created_at: now,
      updated_at: now,
    })
    .select("id, slug, status")
    .single();

  if (insertError || !data) {
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

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 201,
    publicMessage: "Course draft created.",
    details: { course_id: (data as CreatedCourse).id },
  });

  return apiOk({ course: data as CreatedCourse }, { status: 201, message: "Course draft created." });
}

