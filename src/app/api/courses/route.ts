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

  if (!["super_admin", "system_admin", "organization_admin"].includes(caller.role)) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const validation = validateSchema(createCourseSchema, body);
  if (!validation.success) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: validation.error });
    return apiError("VALIDATION_ERROR", validation.error, { status: 400 });
  }

  const { title, description, excerpt, visibility_scope, organization_ids } = validation.data;

  const supabase = await createServerSupabaseClient();

  // org_admin can only create org-owned courses (never global / never selected-org catalog)
  const isOrgAdmin = caller.role === "organization_admin";
  const isSuperSystem = caller.role === "super_admin" || caller.role === "system_admin";

  const now = new Date().toISOString();

  let insertPayload: Record<string, unknown> = {
    title,
    description,
    excerpt,
    created_by: caller.id,
    is_published: false,
    created_at: now,
    updated_at: now,
  };

  if (isOrgAdmin) {
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
    insertPayload = {
      ...insertPayload,
      organization_id: caller.organization_id,
      visibility_scope: "organizations",
    };
  } else if (isSuperSystem) {
    if (visibility_scope === "all") {
      insertPayload = {
        ...insertPayload,
        organization_id: null,
        visibility_scope: "all",
      };
    } else {
      insertPayload = {
        ...insertPayload,
        organization_id: null,
        visibility_scope: "organizations",
      };
    }
  }

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

  // For super/system: if visibility is "organizations", insert selected org visibility rows
  if (isSuperSystem && visibility_scope === "organizations") {
    const orgIds = Array.isArray(organization_ids) ? organization_ids : [];

    if (orgIds.length > 0) {
      const rows = orgIds.map((orgId) => ({ course_id: created.id, organization_id: orgId }));
      const { error: linkError } = await supabase.from("course_organizations").insert(rows);
      if (linkError) {
        // Best-effort rollback: keep the course (still manageable by admins); surface a clear error.
        await logApiEvent({
          request,
          caller,
          outcome: "error",
          status: 500,
          code: "INTERNAL",
          publicMessage: "Course created but org visibility failed.",
          internalMessage: linkError.message,
          details: { course_id: created.id },
        });
        return apiError("INTERNAL", "Course created but org visibility failed.", { status: 500 });
      }
    }
  }

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
        visibility_scope: isOrgAdmin ? "organizations" : visibility_scope,
        organization_ids: isOrgAdmin ? [caller.organization_id] : (organization_ids ?? []),
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

