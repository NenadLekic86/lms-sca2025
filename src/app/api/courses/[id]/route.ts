import { NextRequest } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { emitNotificationToUsers } from "@/lib/notifications/server";
import { updateCourseSchema, validateSchema } from "@/lib/validations/schemas";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

type CourseRow = {
  id: string;
  organization_id: string | null;
  title: string | null;
  description: string | null;
  excerpt: string | null;
  is_published: boolean | null;
  visibility_scope: "all" | "organizations" | null;
  cover_image_url: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_by: string | null;
};

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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

  // Courses module is org-scoped; system/super should not access course records directly.
  if (caller.role !== "organization_admin" && caller.role !== "member") {
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const supabase = await createServerSupabaseClient();
  const { data, error: loadError } = await supabase
    .from("courses")
    .select(
      "id, organization_id, title, description, excerpt, is_published, visibility_scope, cover_image_url, created_at, updated_at, created_by"
    )
    .eq("id", id)
    .single();

  if (loadError || !data) {
    return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  }

  return apiOk({ course: data as CourseRow }, { status: 200 });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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

  if (caller.role !== "organization_admin") {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const bodyRec: Record<string, unknown> = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const hasBodyKey = (key: string) => Object.prototype.hasOwnProperty.call(bodyRec, key);

  const validation = validateSchema(updateCourseSchema, body);
  if (!validation.success) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: validation.error });
    return apiError("VALIDATION_ERROR", validation.error, { status: 400 });
  }

  const supabase = await createServerSupabaseClient();

  // Load current to support publish validations and visibility updates
  const { data: current, error: currentError } = await supabase
    .from("courses")
    .select("id, organization_id, is_published, visibility_scope")
    .eq("id", id)
    .single();

  if (currentError || !current) {
    return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  }

  const now = new Date().toISOString();
  const patch = validation.data;

  const isOrgAdmin = caller.role === "organization_admin";

  // Org admin cannot edit global or assigned catalog courses; only org-owned courses.
  if (isOrgAdmin) {
    if (!caller.organization_id || (current as CourseRow).organization_id !== caller.organization_id) {
      await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }
  }

  // If the patch attempts to publish a selected-org course, ensure it has at least one organization assigned
  const wantsPublish = hasBodyKey("is_published") && patch.is_published === true;
  const publishTransition = wantsPublish && (current as CourseRow).is_published !== true;

  // If publishing, ensure the course has a real assessment (test + at least 1 question).
  // Also: we will auto-publish the test after the course is updated, so members can see it under RLS.
  let latestTestForPublish: { id: string; is_published: boolean | null } | null = null;
  let latestTestQuestionCount: number | null = null;
  if (publishTransition) {
    const admin = createAdminSupabaseClient();
    const { data: t, error: tErr } = await admin
      .from("tests")
      .select("id, is_published")
      .eq("course_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (tErr) {
      return apiError("INTERNAL", "Failed to validate assessment.", { status: 500 });
    }
    if (!t?.id) {
      return apiError("VALIDATION_ERROR", "Cannot publish: assessment test is missing. Create an assessment in Step 3.", { status: 400 });
    }

    const { count, error: qErr } = await admin
      .from("test_questions")
      .select("id", { count: "exact", head: true })
      .eq("test_id", t.id);
    if (qErr) {
      return apiError("INTERNAL", "Failed to validate assessment.", { status: 500 });
    }
    const qc = typeof count === "number" ? count : 0;
    if (qc < 1) {
      return apiError("VALIDATION_ERROR", "Cannot publish: add at least 1 assessment question (Step 3).", { status: 400 });
    }

    latestTestForPublish = { id: t.id as string, is_published: (t as { is_published?: boolean | null }).is_published ?? null };
    latestTestQuestionCount = qc;
  }

  const updatePayload: Record<string, unknown> = { updated_at: now };

  // IMPORTANT:
  // Only update columns when the client explicitly sent the key.
  // This prevents optional fields (excerpt/description) from being wiped to NULL
  // when other steps submit a partial PATCH payload (e.g. publish step).
  if (hasBodyKey("title")) updatePayload.title = patch.title;
  if (hasBodyKey("description")) updatePayload.description = patch.description;
  if (hasBodyKey("excerpt")) updatePayload.excerpt = patch.excerpt;
  if (hasBodyKey("is_published")) updatePayload.is_published = patch.is_published;

  const { data: updated, error: updateError } = await supabase
    .from("courses")
    .update(updatePayload)
    .eq("id", id)
    .select(
      "id, organization_id, title, description, excerpt, is_published, visibility_scope, cover_image_url, created_at, updated_at, created_by"
    )
    .single();

  if (updateError || !updated) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to update course.", internalMessage: updateError?.message });
    return apiError("INTERNAL", "Failed to update course.", { status: 500 });
  }

  // When a course is (re)published, ensure the latest assessment test is also published.
  // Members can only read published tests under RLS, so this is required for "Begin Test" to work.
  if (wantsPublish) {
    const admin = createAdminSupabaseClient();

    let t = latestTestForPublish;
    let qc = latestTestQuestionCount;

    if (!t) {
      const { data: t2, error: tErr } = await admin
        .from("tests")
        .select("id, is_published")
        .eq("course_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (tErr) {
        return apiError("INTERNAL", "Course updated but failed to load assessment.", { status: 500 });
      }
      if (t2?.id) {
        t = { id: t2.id as string, is_published: (t2 as { is_published?: boolean | null }).is_published ?? null };
      }
    }

    // If there is no test, don't error for already-published legacy courses.
    // (New publishes are blocked earlier by publishTransition validation.)
    if (t?.id) {
      if (qc == null) {
        const { count, error: qErr } = await admin
          .from("test_questions")
          .select("id", { count: "exact", head: true })
          .eq("test_id", t.id);
        if (qErr) {
          return apiError("INTERNAL", "Course updated but failed to validate assessment.", { status: 500 });
        }
        qc = typeof count === "number" ? count : 0;
      }

      if ((qc ?? 0) > 0 && t.is_published !== true) {
        const { error: pubErr } = await admin.from("tests").update({ is_published: true }).eq("id", t.id);
        if (pubErr) {
          return apiError("INTERNAL", "Course updated but failed to publish assessment.", { status: 500 });
        }
      }
    }
  }

  // Best-effort audit log
  try {
    await supabase.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "update_course",
      entity: "courses",
      entity_id: id,
      metadata: { patch_keys: Object.keys(bodyRec) },
    });
  } catch {
    // ignore
  }

  // Best-effort notifications: publish-only (no draft spam)
  if (publishTransition) {
    try {
      const course = updated as CourseRow;
      const courseTitle = (course.title ?? "").trim() || "(untitled)";

      const admin = createAdminSupabaseClient();
      const activeFilter = "is_active.is.null,is_active.eq.true";

      // Always notify super_admin + system_admin
      const { data: superSystemUsers } = await admin
        .from("users")
        .select("id")
        .in("role", ["super_admin", "system_admin"])
        .or(activeFilter);

      const superSystemIds = (Array.isArray(superSystemUsers) ? superSystemUsers : [])
        .map((r: { id?: string | null }) => r.id)
        .filter((v): v is string => typeof v === "string");

      // Members: notify when course is visible to their org(s).
      let orgUserIds: string[] = [];

      // Org-owned course → notify org members + org admins in that org.
      if (course.organization_id) {
        const orgId = course.organization_id;

        const { data: orgUsers } = await admin
          .from("users")
          .select("id, role")
          .in("role", ["organization_admin", "member"])
          .eq("organization_id", orgId)
          .or(activeFilter);

        const ids = (Array.isArray(orgUsers) ? orgUsers : [])
          .map((r: { id?: string | null }) => r.id)
          .filter((v): v is string => typeof v === "string");

        orgUserIds = ids;
      }

      await emitNotificationToUsers({
        actorUserId: caller.id,
        recipientUserIds: [...superSystemIds, ...orgUserIds],
        notification: {
          type: "course_published",
          title: "New course published",
          body: courseTitle,
          org_id: course.organization_id ?? null,
          entity: "courses",
          entity_id: course.id,
          href: null,
          metadata: {
            title: courseTitle,
            visibility_scope: course.visibility_scope,
            organization_id: course.organization_id,
          },
        },
      });
    } catch {
      // ignore
    }
  }

  await logApiEvent({ request, caller, outcome: "success", status: 200, publicMessage: "Course updated.", details: { course_id: id } });
  return apiOk({ course: updated as CourseRow }, { status: 200, message: "Course updated." });
}

