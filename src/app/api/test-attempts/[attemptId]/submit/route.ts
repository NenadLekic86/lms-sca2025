import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { validateSchema } from "@/lib/validations/schemas";

export const runtime = "nodejs";

const submitSchema = z.object({
  answers: z.record(z.string().uuid(), z.array(z.string().uuid()).max(20)),
});

type QuestionRow = { id: string; points: number; type: string };
type OptionRow = { id: string; question_id: string; is_correct: boolean };
type TestRow = { id: string; course_id: string | null; pass_score: number | null };

export async function POST(request: NextRequest, context: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (caller.role !== "member") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const validation = validateSchema(submitSchema, body);
  if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });

  const admin = createAdminSupabaseClient();

  // Load attempt (service role) and verify ownership + not already submitted.
  const { data: attempt, error: attemptError } = await admin
    .from("test_attempts")
    .select("id, test_id, user_id, organization_id, submitted_at")
    .eq("id", attemptId)
    .single();

  if (attemptError || !attempt) return NextResponse.json({ error: attemptError?.message || "Attempt not found" }, { status: 404 });
  if (attempt.user_id !== caller.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (attempt.submitted_at) return NextResponse.json({ error: "Attempt already submitted" }, { status: 400 });

  // Load test settings for pass score.
  const { data: test, error: testError } = await admin
    .from("tests")
    .select("id, course_id, pass_score")
    .eq("id", attempt.test_id)
    .single();

  if (testError || !test) return NextResponse.json({ error: testError?.message || "Test not found" }, { status: 404 });

  const testRow = test as unknown as TestRow;
  const courseId = typeof testRow.course_id === "string" ? testRow.course_id : null;
  const passScore = typeof testRow.pass_score === "number" ? testRow.pass_score : 0;

  // Load questions + correct options.
  const { data: questionsData, error: qError } = await admin
    .from("test_questions")
    .select("id, points, type")
    .eq("test_id", attempt.test_id);

  if (qError) return NextResponse.json({ error: qError.message }, { status: 500 });

  const questions = (Array.isArray(questionsData) ? questionsData : []) as unknown as QuestionRow[];
  const questionIds = questions.map((q) => q.id);

  const { data: optionsData, error: oError } = questionIds.length
    ? await admin
        .from("test_question_options")
        .select("id, question_id, is_correct")
        .in("question_id", questionIds)
    : { data: [], error: null };

  if (oError) return NextResponse.json({ error: oError.message }, { status: 500 });
  const options = (Array.isArray(optionsData) ? optionsData : []) as unknown as OptionRow[];

  const correctByQuestion = new Map<string, Set<string>>();
  for (const o of options) {
    if (!o.is_correct) continue;
    if (!correctByQuestion.has(o.question_id)) correctByQuestion.set(o.question_id, new Set());
    correctByQuestion.get(o.question_id)!.add(o.id);
  }

  const answers = validation.data.answers;
  let earned = 0;
  let total = 0;

  for (const q of questions) {
    const points = Number.isFinite(q.points) ? q.points : 1;
    total += points;

    const correct = correctByQuestion.get(q.id) ?? new Set<string>();
    const selected = new Set((answers[q.id] ?? []).filter((v) => typeof v === "string"));

    // Exact match grading (v1): must select all and only correct options.
    let ok = selected.size === correct.size;
    if (ok) {
      for (const id of correct) {
        if (!selected.has(id)) {
          ok = false;
          break;
        }
      }
    }
    if (ok) earned += points;
  }

  const score = total > 0 ? Math.round((earned / total) * 1000) / 10 : 0; // 1 decimal
  const passed = score >= passScore;

  const now = new Date().toISOString();
  const { error: updError } = await admin
    .from("test_attempts")
    .update({
      score,
      passed,
      submitted_at: now,
      answers,
    })
    .eq("id", attemptId);

  if (updError) return NextResponse.json({ error: updError.message }, { status: 500 });

  // If passed: issue certificate + mark enrollment complete (best-effort, idempotent).
  // IMPORTANT: do not fail the request after the attempt is saved (member would be stuck).
  if (passed) {
    try {
      const orgId =
        (typeof attempt.organization_id === "string" && attempt.organization_id.length > 0 ? attempt.organization_id : null) ??
        (typeof caller.organization_id === "string" && caller.organization_id.length > 0 ? caller.organization_id : null);

      if (courseId && orgId) {
        // Create the certificate record (unique on user_id+course_id; ignore duplicates).
        await admin
          .from("certificates")
          .upsert(
            {
              organization_id: orgId,
              user_id: caller.id,
              course_id: courseId,
              issued_at: now,
              status: "valid",
              expires_at: null,
              source_attempt_id: attemptId,
            },
            { onConflict: "user_id,course_id", ignoreDuplicates: true }
          );

        // Mark enrollment completed (if the column exists in your DB).
        // Keep status as "active" because the learning pages currently require status="active".
        try {
          await admin
            .from("course_enrollments")
            .update({ completed_at: now })
            .eq("course_id", courseId)
            .eq("user_id", caller.id)
            .is("completed_at", null);
        } catch {
          // ignore (e.g. column doesn't exist yet)
        }
      }
    } catch {
      // ignore (certificate issuance is best-effort)
    }
  }

  return NextResponse.json({ ok: true, score, passed, pass_score: passScore }, { status: 200 });
}

