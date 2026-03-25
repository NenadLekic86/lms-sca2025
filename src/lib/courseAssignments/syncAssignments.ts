import { createAdminSupabaseClient } from "@/lib/supabase/server";
import { computeAccessExpiresAt, type AccessDurationKey, isAccessDurationKey } from "@/lib/courseAssignments/access";
import { getActiveOrganizationMemberIds } from "@/lib/organizations/memberships";

type CourseRow = {
  id: string;
  organization_id: string | null;
  title?: string | null;
  visibility_scope?: string | null;
  is_archived?: boolean | null;
};

type UserRow = {
  id: string;
  email?: string | null;
  full_name?: string | null;
  is_active?: boolean | null;
  role?: string | null;
};

type ExistingAssignmentRow = {
  user_id: string | null;
  access_duration_key?: string | null;
  access_expires_at?: string | null;
};

export type CourseAssignmentMember = {
  userId: string;
  email: string | null;
  fullName: string | null;
};

export type DesiredCourseAssignment = {
  userId: string;
  access: AccessDurationKey;
};

export type SyncAssignmentsResult = {
  courseId: string;
  courseTitle: string;
  desiredAssignments: DesiredCourseAssignment[];
  validAssignments: DesiredCourseAssignment[];
  invalidUsers: Array<{ userId: string; reason: string }>;
  addedCount: number;
  updatedCount: number;
  removedCount: number;
  unchangedCount: number;
};

export async function loadActiveOrganizationMembers(
  organizationId: string
): Promise<{ members: CourseAssignmentMember[]; error: string | null }> {
  const admin = createAdminSupabaseClient();
  const membershipLookup = await getActiveOrganizationMemberIds(organizationId, ["member"]);
  if (membershipLookup.error) {
    return { members: [], error: membershipLookup.error };
  }

  if (membershipLookup.userIds.length === 0) {
    return { members: [], error: null };
  }

  const { data, error } = await admin
    .from("users")
    .select("id, email, full_name, is_active, role")
    .in("id", membershipLookup.userIds);

  if (error) {
    return { members: [], error: error.message };
  }

  const members = ((Array.isArray(data) ? data : []) as UserRow[])
    .filter((row) => row.role === "member" && row.is_active !== false)
    .map((row) => ({
      userId: row.id,
      email: typeof row.email === "string" && row.email.trim().length > 0 ? row.email.trim() : null,
      fullName: typeof row.full_name === "string" && row.full_name.trim().length > 0 ? row.full_name.trim() : null,
    }));

  return { members, error: null };
}

export async function loadCourseAssignmentContext(
  courseId: string,
  organizationId: string
): Promise<{
  course: CourseRow | null;
  members: CourseAssignmentMember[];
  currentAssignments: ExistingAssignmentRow[];
  error: string | null;
}> {
  const admin = createAdminSupabaseClient();
  const [{ data: course, error: courseError }, membersResult, { data: currentAssignments, error: assignmentsError }] = await Promise.all([
    admin
      .from("courses")
      .select("id, organization_id, title, visibility_scope, is_archived")
      .eq("id", courseId)
      .maybeSingle(),
    loadActiveOrganizationMembers(organizationId),
    admin
      .from("course_member_assignments")
      .select("user_id, access_duration_key, access_expires_at")
      .eq("course_id", courseId)
      .eq("organization_id", organizationId),
  ]);

  if (courseError) {
    return { course: null, members: [], currentAssignments: [], error: courseError.message };
  }
  if (membersResult.error) {
    return { course: null, members: [], currentAssignments: [], error: membersResult.error };
  }
  if (assignmentsError) {
    return { course: null, members: [], currentAssignments: [], error: assignmentsError.message };
  }

  return {
    course: (course as CourseRow | null) ?? null,
    members: membersResult.members,
    currentAssignments: (Array.isArray(currentAssignments) ? currentAssignments : []) as ExistingAssignmentRow[],
    error: null,
  };
}

export function deriveExistingAssignmentAccessKey(row: ExistingAssignmentRow): AccessDurationKey {
  const raw = typeof row.access_duration_key === "string" ? row.access_duration_key : null;
  if (isAccessDurationKey(raw)) return raw;
  return row.access_expires_at ? "1m" : "unlimited";
}

export async function syncCourseMemberAssignments(input: {
  organizationId: string;
  courseId: string;
  actorUserId: string;
  desiredAssignments: DesiredCourseAssignment[];
}): Promise<{ result: SyncAssignmentsResult | null; error: string | null; code?: "NOT_FOUND" | "FORBIDDEN" | "INTERNAL" }> {
  const admin = createAdminSupabaseClient();
  const context = await loadCourseAssignmentContext(input.courseId, input.organizationId);
  if (context.error) {
    return { result: null, error: context.error, code: "INTERNAL" };
  }

  const course = context.course;
  if (!course?.id) {
    return { result: null, error: "Course not found.", code: "NOT_FOUND" };
  }
  if (course.organization_id !== input.organizationId) {
    return { result: null, error: "Forbidden", code: "FORBIDDEN" };
  }

  const uniqueDesired = Array.from(new Map(input.desiredAssignments.map((row) => [row.userId, row])).values());
  const memberIds = new Set(context.members.map((member) => member.userId));

  const validAssignments: DesiredCourseAssignment[] = [];
  const invalidUsers: Array<{ userId: string; reason: string }> = [];
  for (const row of uniqueDesired) {
    if (!memberIds.has(row.userId)) {
      invalidUsers.push({ userId: row.userId, reason: "User does not belong to your organization." });
      continue;
    }
    validAssignments.push(row);
  }

  const currentByUserId = new Map<string, ExistingAssignmentRow>();
  for (const row of context.currentAssignments) {
    if (typeof row.user_id === "string" && row.user_id.length > 0) {
      currentByUserId.set(row.user_id, row);
    }
  }

  const desiredUserIds = new Set(validAssignments.map((row) => row.userId));
  const existingUserIds = new Set(currentByUserId.keys());

  const toRemove = Array.from(existingUserIds).filter((userId) => !desiredUserIds.has(userId));
  const toUpsert = validAssignments.filter((row) => {
    const existing = currentByUserId.get(row.userId);
    if (!existing) return true;
    return deriveExistingAssignmentAccessKey(existing) !== row.access;
  });

  if (toUpsert.length > 0) {
    const now = new Date();
    const payload = toUpsert.map((row) => ({
      organization_id: input.organizationId,
      course_id: input.courseId,
      user_id: row.userId,
      assigned_by: input.actorUserId,
      assigned_at: now.toISOString(),
      access_duration_key: row.access === "unlimited" ? null : row.access,
      access_expires_at: computeAccessExpiresAt(row.access, now),
    }));

    const { error } = await admin
      .from("course_member_assignments")
      .upsert(payload, { onConflict: "course_id,user_id", ignoreDuplicates: false });

    if (error) {
      return { result: null, error: error.message, code: "INTERNAL" };
    }
  }

  if (toRemove.length > 0) {
    const { error } = await admin
      .from("course_member_assignments")
      .delete()
      .eq("course_id", input.courseId)
      .eq("organization_id", input.organizationId)
      .in("user_id", toRemove);

    if (error) {
      return { result: null, error: error.message, code: "INTERNAL" };
    }
  }

  const addedCount = toUpsert.filter((row) => !existingUserIds.has(row.userId)).length;
  const updatedCount = toUpsert.length - addedCount;
  const unchangedCount = validAssignments.length - toUpsert.length;

  return {
    result: {
      courseId: input.courseId,
      courseTitle: typeof course.title === "string" && course.title.trim().length > 0 ? course.title.trim() : "Untitled course",
      desiredAssignments: uniqueDesired,
      validAssignments,
      invalidUsers,
      addedCount,
      updatedCount,
      removedCount: toRemove.length,
      unchangedCount,
    },
    error: null,
  };
}
