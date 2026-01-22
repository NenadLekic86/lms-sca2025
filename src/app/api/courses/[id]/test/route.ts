import { NextRequest } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

type TestRow = {
  id: string;
  title: string | null;
  course_id: string | null;
  organization_id: string | null;
  is_published: boolean | null;
  max_attempts: number | null;
  pass_score: number | null;
  created_at: string | null;
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

  // Session client so RLS can apply later if needed.
  const supabase = await createServerSupabaseClient();
  const { data, error: loadError } = await supabase
    .from("tests")
    .select("id, title, course_id, organization_id, is_published, max_attempts, pass_score, created_at")
    .eq("course_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (loadError) return apiError("INTERNAL", "Failed to load test.", { status: 500 });

  let questionCount = 0;
  if (data?.id) {
    const { count } = await supabase
      .from("test_questions")
      .select("id", { count: "exact", head: true })
      .eq("test_id", data.id);
    questionCount = count ?? 0;
  }

  return apiOk({ test: (data as TestRow | null) ?? null, questionCount }, { status: 200 });
}

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

  if (!["super_admin", "system_admin", "organization_admin"].includes(caller.role)) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  const { data: courseRow, error: courseError } = await admin
    .from("courses")
    .select("id, title, organization_id")
    .eq("id", id)
    .single();

  if (courseError || !courseRow) {
    await logApiEvent({ request, caller, outcome: "error", status: 404, code: "NOT_FOUND", publicMessage: "Course not found.", internalMessage: courseError?.message });
    return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  }

  // Org admins can only create tests for org-owned courses
  if (caller.role === "organization_admin") {
    if (!caller.organization_id || courseRow.organization_id !== caller.organization_id) {
      await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden", internalMessage: "org mismatch" });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }
  }

  // If already exists, return existing
  const { data: existing } = await admin
    .from("tests")
    .select("id, title, course_id, organization_id, is_published, max_attempts, pass_score, created_at")
    .eq("course_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    return apiOk({ test: existing as TestRow }, { status: 200 });
  }

  const title = `${(courseRow.title ?? "Course").trim() || "Course"} Assessment`;

  const { data: inserted, error: insertError } = await admin
    .from("tests")
    .insert({
      title,
      course_id: id,
      organization_id: courseRow.organization_id,
      is_published: false,
      max_attempts: 1,
      pass_score: 0,
    })
    .select("id, title, course_id, organization_id, is_published, max_attempts, pass_score, created_at")
    .single();

  if (insertError || !inserted) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to create test.", internalMessage: insertError?.message });
    return apiError("INTERNAL", "Failed to create test.", { status: 500 });
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "create_course_test",
      entity: "courses",
      entity_id: id,
      metadata: { test_id: inserted.id },
    });
  } catch {
    // ignore
  }

  await logApiEvent({ request, caller, outcome: "success", status: 201, publicMessage: "Assessment created.", details: { course_id: id, test_id: inserted.id } });
  return apiOk({ test: inserted as TestRow }, { status: 201, message: "Assessment created." });
}

