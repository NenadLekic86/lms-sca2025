import { NextRequest, NextResponse } from "next/server";

import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { buildCourseAssignmentCsv } from "@/lib/courseAssignments/csv";
import { deriveExistingAssignmentAccessKey, loadCourseAssignmentContext } from "@/lib/courseAssignments/syncAssignments";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { apiError } from "@/lib/api/response";

export const runtime = "nodejs";

function toCsvFilename(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "course";
}

export async function GET(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }
  if (caller.role !== "organization_admin" || !caller.organization_id) {
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const contextResult = await loadCourseAssignmentContext(courseId, caller.organization_id);
  if (contextResult.error) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to build assignment CSV.",
      internalMessage: contextResult.error,
    });
    return apiError("INTERNAL", "Failed to build assignment CSV.", { status: 500 });
  }
  if (!contextResult.course?.id || contextResult.course.organization_id !== caller.organization_id) {
    return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  }

  const members = contextResult.members;
  const currentByUserId = new Map(
    contextResult.currentAssignments
      .filter((row) => typeof row.user_id === "string" && row.user_id.length > 0)
      .map((row) => [row.user_id as string, row])
  );

  const courseTitle =
    typeof contextResult.course.title === "string" && contextResult.course.title.trim().length > 0
      ? contextResult.course.title.trim()
      : "Untitled course";

  const csv = buildCourseAssignmentCsv(
    members.map((member) => {
      const existing = currentByUserId.get(member.userId);
      return {
        user_id: member.userId,
        email: member.email ?? "",
        full_name: member.fullName ?? "",
        course_id: courseId,
        course_title: courseTitle,
        assigned: Boolean(existing),
        tfa: existing ? deriveExistingAssignmentAccessKey(existing) : "",
      };
    })
  );

  const admin = createAdminSupabaseClient();
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "export_course_assignment_template",
      entity: "courses",
      entity_id: courseId,
      metadata: {
        organization_id: caller.organization_id,
        course_id: courseId,
        course_title: courseTitle,
        row_count: members.length,
        format: "csv",
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
    publicMessage: "Course assignment CSV exported.",
    details: { course_id: courseId, row_count: members.length },
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${toCsvFilename(courseTitle)}-assignments.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
