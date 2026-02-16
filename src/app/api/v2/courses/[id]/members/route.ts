import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { setCourseMembersSchema, validateSchema } from "@/lib/validations/schemas";
import { computeAccessExpiresAt, type AccessDurationKey, isAccessDurationKey } from "@/lib/courseAssignments/access";

type AssignmentRow = { user_id: string; access_duration_key?: string | null; access_expires_at?: string | null };

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

  const { data: usersInOrg, error: usersError } = await admin
    .from("users")
    .select("id, role, is_active")
    .eq("organization_id", caller.organization_id)
    .eq("role", "member");
  if (usersError) return apiError("INTERNAL", "Failed to validate members.", { status: 500 });

  const activeMembers = new Set(
    (Array.isArray(usersInOrg) ? usersInOrg : [])
      .filter((u) => u.is_active !== false)
      .map((u) => u.id)
      .filter((v): v is string => typeof v === "string")
  );

  const validDesired = desired.filter((id) => activeMembers.has(id));

  const { data: currentRows, error: currentError } = await admin
    .from("course_member_assignments")
    .select("user_id, access_duration_key, access_expires_at")
    .eq("course_id", id)
    .eq("organization_id", caller.organization_id);
  if (currentError) return apiError("INTERNAL", "Failed to load current assignments.", { status: 500 });

  const currentList = (Array.isArray(currentRows) ? currentRows : []) as AssignmentRow[];
  const current = new Set(currentList.map((r) => r.user_id).filter((v): v is string => typeof v === "string"));
  const currentAccessByUserId = new Map<string, AccessDurationKey>();
  for (const r of currentList) {
    const uid = typeof r.user_id === "string" ? r.user_id : null;
    if (!uid) continue;
    const key = typeof r.access_duration_key === "string" ? r.access_duration_key : null;
    if (isAccessDurationKey(key)) currentAccessByUserId.set(uid, key);
    else currentAccessByUserId.set(uid, r.access_expires_at ? "1m" : "unlimited");
  }

  const toAdd = validDesired.filter((uid) => !current.has(uid));
  const toRemove = [...current].filter((uid) => !validDesired.includes(uid));

  if (validDesired.length > 0) {
    const now = new Date();
    const desiredAccessByUserId = new Map<string, AccessDurationKey>();
    for (const uid of validDesired) {
      const keyRaw = (memberAccess as Record<string, unknown>)[uid];
      const key: AccessDurationKey = isAccessDurationKey(keyRaw) ? (keyRaw as AccessDurationKey) : defaultAccess;
      desiredAccessByUserId.set(uid, key);
    }

    const toUpsert = validDesired.filter((uid) => {
      const existingKey = currentAccessByUserId.get(uid);
      const desiredKey = desiredAccessByUserId.get(uid) ?? defaultAccess;
      return !current.has(uid) || existingKey !== desiredKey;
    });

    const payload = toUpsert.map((uid) => {
      const keyRaw = (memberAccess as Record<string, unknown>)[uid];
      const key: AccessDurationKey = isAccessDurationKey(keyRaw) ? (keyRaw as AccessDurationKey) : defaultAccess;
      const access_expires_at = computeAccessExpiresAt(key, now);
      return {
      organization_id: caller.organization_id!,
      course_id: id,
      user_id: uid,
      assigned_by: caller.id,
      assigned_at: now.toISOString(),
      access_duration_key: key === "unlimited" ? null : key,
      access_expires_at,
    };
    });
    if (payload.length > 0) {
      const { error: insertError } = await admin
        .from("course_member_assignments")
        .upsert(payload, { onConflict: "course_id,user_id", ignoreDuplicates: false });
      if (insertError) return apiError("INTERNAL", "Failed to add member assignments.", { status: 500 });
    }
  }

  if (toRemove.length > 0) {
    const { error: removeError } = await admin
      .from("course_member_assignments")
      .delete()
      .eq("course_id", id)
      .eq("organization_id", caller.organization_id)
      .in("user_id", toRemove);
    if (removeError) return apiError("INTERNAL", "Failed to remove member assignments.", { status: 500 });
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Course members updated.",
    details: {
      course_id: id,
      added_count: toAdd.length,
      removed_count: toRemove.length,
    },
  });

  return apiOk(
    {
      course_id: id,
      member_ids: validDesired,
      added_count: toAdd.length,
      removed_count: toRemove.length,
    },
    { status: 200, message: "Course members updated." }
  );
}

