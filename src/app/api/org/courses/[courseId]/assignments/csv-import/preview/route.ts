import { NextRequest } from "next/server";

import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { normalizeAccessCell, normalizeAssignedCell, parseCourseAssignmentCsv } from "@/lib/courseAssignments/csv";
import { deriveExistingAssignmentAccessKey, loadCourseAssignmentContext } from "@/lib/courseAssignments/syncAssignments";
import { getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

type PreviewRow = {
  row_number: number;
  user_id: string;
  email: string;
  full_name: string;
  assigned: boolean;
  tfa: "unlimited" | "3m" | "1m" | "1w" | null;
  action: "assign" | "update" | "remove" | "unchanged";
};

type InvalidRow = {
  row_number: number;
  user_id: string;
  email: string;
  full_name: string;
  error: string;
};

export async function POST(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const form = await request.formData().catch(() => null);
  if (!form) return apiError("VALIDATION_ERROR", "Invalid upload.", { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return apiError("VALIDATION_ERROR", "Missing CSV file.", { status: 400 });

  const text = await file.text().catch(() => "");
  const parsed = parseCourseAssignmentCsv(text);
  if (parsed.error) {
    return apiError("VALIDATION_ERROR", parsed.error, { status: 400 });
  }

  const contextResult = await loadCourseAssignmentContext(courseId, caller.organization_id);
  if (contextResult.error) {
    return apiError("INTERNAL", "Failed to validate course assignment import.", { status: 500 });
  }
  if (!contextResult.course?.id || contextResult.course.organization_id !== caller.organization_id) {
    return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  }

  const currentByUserId = new Map(
    contextResult.currentAssignments
      .filter((row) => typeof row.user_id === "string" && row.user_id.length > 0)
      .map((row) => [row.user_id as string, row])
  );
  const memberByUserId = new Map(contextResult.members.map((member) => [member.userId, member]));
  const validRows: PreviewRow[] = [];
  const invalidRows: InvalidRow[] = [];
  const seenUserIds = new Set<string>();

  for (const row of parsed.rows) {
    const assigned = normalizeAssignedCell(row.assigned_raw);
    if (assigned === null) {
      invalidRows.push({ row_number: row.rowNumber, user_id: row.user_id, email: row.email, full_name: row.full_name, error: "Invalid assigned value. Use true/false." });
      continue;
    }
    if (row.course_id !== courseId) {
      invalidRows.push({ row_number: row.rowNumber, user_id: row.user_id, email: row.email, full_name: row.full_name, error: "Course ID does not match the selected course." });
      continue;
    }
    if (seenUserIds.has(row.user_id)) {
      invalidRows.push({ row_number: row.rowNumber, user_id: row.user_id, email: row.email, full_name: row.full_name, error: "Duplicate user_id in CSV." });
      continue;
    }
    seenUserIds.add(row.user_id);

    const member = memberByUserId.get(row.user_id);
    if (!member) {
      invalidRows.push({ row_number: row.rowNumber, user_id: row.user_id, email: row.email, full_name: row.full_name, error: "User is not an active member of this organization." });
      continue;
    }

    const tfa = assigned ? normalizeAccessCell(row.tfa_raw) : null;
    if (assigned && !tfa) {
      invalidRows.push({
        row_number: row.rowNumber,
        user_id: row.user_id,
        email: row.email,
        full_name: row.full_name,
        error: "Assigned rows must include TFA value: unlimited, 3m, 1m, or 1w.",
      });
      continue;
    }

    const existing = currentByUserId.get(row.user_id);
    let action: PreviewRow["action"] = "unchanged";
    if (assigned) {
      action = existing ? (deriveExistingAssignmentAccessKey(existing) === tfa ? "unchanged" : "update") : "assign";
    } else {
      action = existing ? "remove" : "unchanged";
    }

    validRows.push({
      row_number: row.rowNumber,
      user_id: row.user_id,
      email: member.email ?? row.email,
      full_name: member.fullName ?? row.full_name,
      assigned,
      tfa,
      action,
    });
  }

  const summary = {
    total_rows: parsed.rows.length,
    valid_rows: validRows.length,
    invalid_rows: invalidRows.length,
    assign_count: validRows.filter((row) => row.action === "assign").length,
    update_count: validRows.filter((row) => row.action === "update").length,
    remove_count: validRows.filter((row) => row.action === "remove").length,
    unchanged_count: validRows.filter((row) => row.action === "unchanged").length,
  };

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Course assignment CSV preview generated.",
    details: {
      course_id: courseId,
      total_rows: summary.total_rows,
      valid_rows: summary.valid_rows,
      invalid_rows: summary.invalid_rows,
    },
  });

  return apiOk(
    {
      course: {
        id: courseId,
        title:
          typeof contextResult.course.title === "string" && contextResult.course.title.trim().length > 0
            ? contextResult.course.title.trim()
            : "Untitled course",
      },
      summary,
      valid_rows: validRows,
      invalid_rows: invalidRows,
      normalized_rows: validRows.map((row) => ({
        user_id: row.user_id,
        assigned: row.assigned,
        tfa: row.tfa,
      })),
    },
    { status: 200, message: "CSV preview ready." }
  );
}
