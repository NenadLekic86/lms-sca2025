import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(_request: NextRequest, context: { params: Promise<{ testId: string }> }) {
  const { testId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (caller.role !== "member") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!caller.organization_id) return NextResponse.json({ error: "Missing organization" }, { status: 400 });

  // Load test using session client so RLS enforces:
  // - test is published
  // - member is enrolled in the course
  const supabase = await createServerSupabaseClient();
  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id, course_id, is_published, max_attempts, pass_score")
    .eq("id", testId)
    .single();

  if (testError || !test) return NextResponse.json({ error: testError?.message || "Test not found" }, { status: 404 });
  if (test.is_published !== true) return NextResponse.json({ error: "Test not published" }, { status: 400 });

  const courseId = test.course_id as string | null;
  if (!courseId) return NextResponse.json({ error: "Test is missing course" }, { status: 500 });

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
  if (total === 0) return NextResponse.json({ error: "Course has no content" }, { status: 400 });

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
  if (missing) return NextResponse.json({ error: "Complete the course content before starting the test." }, { status: 400 });

  // Use admin client for attempt creation (members don't have insert policy on test_attempts).
  const admin = createAdminSupabaseClient();

  // Count attempts (started or submitted).
  const { count: attemptCount, error: countError } = await admin
    .from("test_attempts")
    .select("id", { count: "exact", head: true })
    .eq("test_id", testId)
    .eq("user_id", caller.id);

  if (countError) return NextResponse.json({ error: countError.message }, { status: 500 });

  const maxAttempts = typeof test.max_attempts === "number" ? test.max_attempts : 1;
  const nextAttemptNumber = (attemptCount ?? 0) + 1;

  if (nextAttemptNumber > maxAttempts) {
    return NextResponse.json({ error: "No attempts remaining." }, { status: 400 });
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

  if (insError || !inserted) return NextResponse.json({ error: insError?.message || "Failed to start attempt" }, { status: 500 });

  return NextResponse.json(
    {
      ok: true,
      attempt: inserted,
      max_attempts: maxAttempts,
      pass_score: test.pass_score,
    },
    { status: 201 }
  );
}

