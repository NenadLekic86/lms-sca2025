import { NextRequest } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ testId: string }> }) {
  const { testId } = await context.params;
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
  if (!caller.organization_id) return apiError("VALIDATION_ERROR", "Missing organization.", { status: 400 });

  // Load test using session client so RLS enforces:
  // - test is published
  // - member is enrolled in the course
  const supabase = await createServerSupabaseClient();
  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id, course_id, is_published, max_attempts, pass_score")
    .eq("id", testId)
    .single();

  if (testError || !test) return apiError("NOT_FOUND", "Test not found.", { status: 404 });
  if (test.is_published !== true) return apiError("VALIDATION_ERROR", "This test is not published yet.", { status: 400 });

  const courseId = test.course_id as string | null;
  if (!courseId) return apiError("INTERNAL", "Test is missing course.", { status: 500 });

  // Enforce: must complete all course items before starting test.
  const [{ data: resources }, { data: videos }, { data: progressRows }] = await Promise.all([
    supabase.from("course_resources").select("id").eq("course_id", courseId),
    supabase.from("course_videos").select("id").eq("course_id", courseId),
    supabase
      .from("course_content_progress")
      .select("item_type, item_id, completed_at")
      .eq("course_id", courseId)
      .eq("user_id", caller.id),
  ]);

  const resourceIds = (Array.isArray(resources) ? resources : [])
    .map((r: { id?: string | null }) => r.id)
    .filter((v): v is string => typeof v === "string");
  const videoIds = (Array.isArray(videos) ? videos : [])
    .map((r: { id?: string | null }) => r.id)
    .filter((v): v is string => typeof v === "string");

  const total = resourceIds.length + videoIds.length;
  if (total === 0) return apiError("VALIDATION_ERROR", "Course has no content.", { status: 400 });

  const completed = new Set<string>();
  for (const p of (Array.isArray(progressRows) ? progressRows : []) as Array<{
    item_type?: string | null;
    item_id?: string | null;
    completed_at?: string | null;
  }>) {
    if (!p.completed_at) continue;
    const t = p.item_type === "resource" || p.item_type === "video" ? p.item_type : null;
    const id = typeof p.item_id === "string" ? p.item_id : null;
    if (!t || !id) continue;
    completed.add(`${t}:${id}`);
  }

  const missing =
    resourceIds.some((id) => !completed.has(`resource:${id}`)) || videoIds.some((id) => !completed.has(`video:${id}`));
  if (missing) return apiError("VALIDATION_ERROR", "Complete the course content before starting the test.", { status: 400 });

  // Use admin client for attempt creation (members don't have insert policy on test_attempts).
  const admin = createAdminSupabaseClient();

  // Count attempts (started or submitted).
  const { count: attemptCount, error: countError } = await admin
    .from("test_attempts")
    .select("id", { count: "exact", head: true })
    .eq("test_id", testId)
    .eq("user_id", caller.id);

  if (countError) return apiError("INTERNAL", "Failed to start attempt.", { status: 500 });

  const maxAttempts = typeof test.max_attempts === "number" ? test.max_attempts : 1;
  const nextAttemptNumber = (attemptCount ?? 0) + 1;

  if (nextAttemptNumber > maxAttempts) {
    return apiError("VALIDATION_ERROR", "No attempts remaining.", { status: 400 });
  }

  const now = new Date().toISOString();
  const { data: inserted, error: insError } = await admin
    .from("test_attempts")
    .insert({
      organization_id: caller.organization_id,
      test_id: testId,
      user_id: caller.id,
      score: null,
      passed: false,
      started_at: now,
      submitted_at: null,
      attempt_number: nextAttemptNumber,
      answers: {},
    })
    .select("id, attempt_number, started_at")
    .single();

  if (insError || !inserted) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to start attempt.", internalMessage: insError?.message });
    return apiError("INTERNAL", "Failed to start attempt.", { status: 500 });
  }

  await logApiEvent({ request, caller, outcome: "success", status: 201, publicMessage: "Attempt started.", details: { test_id: testId, attempt_id: inserted.id } });
  return apiOk(
    {
      attempt: inserted,
      max_attempts: maxAttempts,
      pass_score: test.pass_score,
    },
    { status: 201, message: "Attempt started." }
  );
}

