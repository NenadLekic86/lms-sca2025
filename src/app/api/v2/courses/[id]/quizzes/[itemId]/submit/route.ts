import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

const submitSchema = z.object({
  // Optional: lets the client flush latest answers and submit in one request.
  answers_json: z.record(z.string(), z.unknown()).optional(),
});

type QuizQuestionType = "true_false" | "single_choice" | "multiple_choice";

type QuizQuestion = {
  id: string;
  type: QuizQuestionType;
  points: number;
  answer_required: boolean;
  correct_boolean?: boolean;
  correct_option_id?: string | null;
  correct_option_ids?: string[];
};

type CorrectAnswer =
  | { kind: "boolean"; value: boolean }
  | { kind: "options"; option_ids: string[] };

type SelectedAnswer =
  | { kind: "none" }
  | { kind: "boolean"; value: boolean }
  | { kind: "options"; option_ids: string[] };

function clampInt(v: unknown, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return Math.max(min, Math.min(max, i));
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function normalizeQuestions(payload: Record<string, unknown>): QuizQuestion[] {
  const raw = Array.isArray(payload.questions) ? (payload.questions as unknown[]) : [];
  return raw
    .map((q) => {
      if (!q || typeof q !== "object") return null;
      const qq = q as Record<string, unknown>;
      const id = asString(qq.id);
      if (!id) return null;
      const type = asString(qq.type) as QuizQuestionType;
      const supported = type === "true_false" || type === "single_choice" || type === "multiple_choice";
      if (!supported) return null;
      const points = clampInt(qq.points, 0, 999, 1);
      const answer_required = Boolean(qq.answer_required ?? true);
      const correct_boolean = typeof qq.correct_boolean === "boolean" ? (qq.correct_boolean as boolean) : undefined;
      const correct_option_id = typeof qq.correct_option_id === "string" ? (qq.correct_option_id as string) : null;
      const correct_option_ids = Array.isArray(qq.correct_option_ids)
        ? (qq.correct_option_ids as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0)
        : [];
      return { id, type, points, answer_required, correct_boolean, correct_option_id, correct_option_ids };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
}

function gradeAttempt(questions: QuizQuestion[], answers: Record<string, unknown>) {
  let totalPoints = 0;
  let earnedPoints = 0;
  const perQuestion: Array<{
    question_id: string;
    correct: boolean;
    earned_points: number;
    points: number;
    missing: boolean;
    correct_answer: CorrectAnswer;
    selected_answer: SelectedAnswer;
  }> = [];

  for (const q of questions) {
    totalPoints += q.points;
    const raw = answers[q.id];
    let correct = false;
    let missing = false;
    let correct_answer: CorrectAnswer = { kind: "options", option_ids: [] };
    let selected_answer: SelectedAnswer = { kind: "none" };

    if (q.type === "true_false") {
      const expected = typeof q.correct_boolean === "boolean" ? q.correct_boolean : true;
      correct_answer = { kind: "boolean", value: expected };
      if (typeof raw !== "boolean") {
        missing = true;
        correct = false;
      } else {
        selected_answer = { kind: "boolean", value: raw };
        correct = raw === expected;
      }
    } else if (q.type === "single_choice") {
      correct_answer = { kind: "options", option_ids: q.correct_option_id ? [q.correct_option_id] : [] };
      if (typeof raw !== "string" || !raw) {
        missing = true;
        correct = false;
      } else {
        selected_answer = { kind: "options", option_ids: [raw] };
        correct = raw === (q.correct_option_id ?? "");
      }
    } else if (q.type === "multiple_choice") {
      if (!Array.isArray(raw)) {
        missing = true;
        correct = false;
      } else {
        const selected = new Set(raw.filter((x): x is string => typeof x === "string" && x.length > 0));
        const expectedIds = (q.correct_option_ids ?? []).filter(Boolean);
        correct_answer = { kind: "options", option_ids: expectedIds };
        selected_answer = { kind: "options", option_ids: Array.from(selected) };
        const expected = new Set(expectedIds);
        if (selected.size !== expected.size) correct = false;
        else {
          correct = true;
          for (const id of expected) {
            if (!selected.has(id)) {
              correct = false;
              break;
            }
          }
        }
      }
    }

    // If answer is required and missing, it's incorrect (already).
    if (q.answer_required && missing) correct = false;

    const earned = correct ? q.points : 0;
    earnedPoints += earned;
    perQuestion.push({ question_id: q.id, correct, earned_points: earned, points: q.points, missing, correct_answer, selected_answer });
  }

  const score_percent = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;
  return { score_percent, earned_points: earnedPoints, total_points: totalPoints, per_question: perQuestion };
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string; itemId: string }> }) {
  const { id: courseId, itemId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({ request, caller: null, outcome: "error", status: 401, code: "UNAUTHORIZED", publicMessage: "Unauthorized" });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }
  if (caller.role !== "member" || !caller.organization_id) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Invalid request.", { status: 400 });

  const supabase = await createServerSupabaseClient();

  const { data: enrollment } = await supabase
    .from("course_enrollments")
    .select("id, status")
    .eq("course_id", courseId)
    .eq("user_id", caller.id)
    .maybeSingle();
  if (!enrollment?.id || enrollment.status !== "active") return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  // Validate quiz item and load payload.
  const { data: item, error: itemError } = await supabase
    .from("course_topic_items")
    .select("id, course_id, organization_id, item_type, payload_json")
    .eq("id", itemId)
    .maybeSingle();
  if (itemError || !item?.id) return apiError("NOT_FOUND", "Quiz not found.", { status: 404 });
  if (String((item as { course_id?: unknown }).course_id ?? "") !== String(courseId)) return apiError("VALIDATION_ERROR", "Invalid quiz.", { status: 400 });
  if (String((item as { item_type?: unknown }).item_type ?? "") !== "quiz") return apiError("VALIDATION_ERROR", "Invalid quiz.", { status: 400 });
  if (String((item as { organization_id?: unknown }).organization_id ?? "") !== String(caller.organization_id)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const payload = (item as { payload_json?: unknown }).payload_json;
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const settings = p.settings && typeof p.settings === "object" ? (p.settings as Record<string, unknown>) : {};

  const attempts_allowed = clampInt(settings.attempts_allowed, 0, 999, 0);
  const passing_grade_percent = clampInt(settings.passing_grade_percent, 0, 100, 80);

  // Active attempt
  const { data: attempt, error: attemptError } = await supabase
    .from("course_v2_quiz_attempts")
    .select("id, attempt_number, status, answers_json, submitted_at")
    .eq("course_id", courseId)
    .eq("item_id", itemId)
    .eq("user_id", caller.id)
    .eq("status", "in_progress")
    .maybeSingle();
  if (attemptError || !attempt?.id) return apiError("CONFLICT", "No active attempt.", { status: 409 });

  // Enforce attempts (0 = unlimited)
  if (attempts_allowed > 0) {
    const { count } = await supabase
      .from("course_v2_quiz_attempts")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId)
      .eq("item_id", itemId)
      .eq("user_id", caller.id)
      .eq("status", "submitted");
    const submitted = typeof count === "number" ? count : 0;
    if (submitted >= attempts_allowed) return apiError("CONFLICT", "Attempts limit reached.", { status: 409 });
  }

  // Optionally flush answers_json in the same request.
  const flushedAnswers = parsed.data.answers_json ?? null;
  if (flushedAnswers && typeof flushedAnswers === "object") {
    const { error: flushError } = await supabase.from("course_v2_quiz_attempts").update({ answers_json: flushedAnswers }).eq("id", attempt.id);
    if (flushError) return apiError("INTERNAL", "Failed to save answers.", { status: 500 });
  }

  // Re-read attempt row after optional flush (ensures we grade latest).
  const { data: attempt2 } = await supabase
    .from("course_v2_quiz_attempts")
    .select("id, attempt_number, answers_json")
    .eq("id", attempt.id)
    .maybeSingle();
  const answers_json = (attempt2 && typeof (attempt2 as { answers_json?: unknown }).answers_json === "object"
    ? ((attempt2 as { answers_json: Record<string, unknown> }).answers_json ?? {})
    : {}) as Record<string, unknown>;

  const questions = normalizeQuestions(p);
  const grade = gradeAttempt(questions, answers_json);
  const passed = grade.score_percent >= passing_grade_percent;

  const now = new Date().toISOString();

  // Mark attempt submitted via member RLS (using old row status=in_progress passes policy).
  const { error: submitError } = await supabase
    .from("course_v2_quiz_attempts")
    .update({ status: "submitted", submitted_at: now })
    .eq("id", attempt.id)
    .eq("status", "in_progress");
  if (submitError) return apiError("INTERNAL", "Failed to submit attempt.", { status: 500 });

  // Persist immutable result + update quiz_state (admin client; bypasses RLS).
  const admin = createAdminSupabaseClient();

  const { error: insertResultError } = await admin.from("course_v2_quiz_attempt_results").insert({
    organization_id: caller.organization_id,
    course_id: courseId,
    user_id: caller.id,
    item_id: itemId,
    attempt_id: attempt.id,
    graded_at: now,
    score_percent: grade.score_percent,
    passed,
    earned_points: grade.earned_points,
    total_points: grade.total_points,
    result_json: { per_question: grade.per_question },
  });
  if (insertResultError) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to save result.",
      internalMessage: insertResultError.message,
    });
    return apiError("INTERNAL", "Failed to save result.", { status: 500 });
  }

  const { data: prevState } = await admin
    .from("course_v2_quiz_state")
    .select("best_score_percent, passed_at")
    .eq("course_id", courseId)
    .eq("item_id", itemId)
    .eq("user_id", caller.id)
    .maybeSingle();
  const prevBest =
    prevState && Number.isFinite(Number((prevState as { best_score_percent?: unknown }).best_score_percent))
      ? Number((prevState as { best_score_percent: number }).best_score_percent)
      : null;
  const nextBest = prevBest === null ? grade.score_percent : Math.max(prevBest, grade.score_percent);
  const prevPassedAt = prevState && typeof (prevState as { passed_at?: unknown }).passed_at === "string" ? String((prevState as { passed_at: string }).passed_at) : null;
  const nextPassedAt = passed ? (prevPassedAt ?? now) : prevPassedAt;

  const { error: upsertStateError } = await admin
    .from("course_v2_quiz_state")
    .upsert(
      {
        organization_id: caller.organization_id,
        course_id: courseId,
        user_id: caller.id,
        item_id: itemId,
        last_attempt_id: attempt.id,
        last_submitted_attempt_id: attempt.id,
        best_score_percent: nextBest,
        passed_at: nextPassedAt,
      },
      { onConflict: "user_id,course_id,item_id" }
    );
  if (upsertStateError) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to update quiz state.",
      internalMessage: upsertStateError.message,
    });
    return apiError("INTERNAL", "Failed to update quiz state.", { status: 500 });
  }

  return apiOk(
    {
      attempt_id: attempt.id,
      score_percent: grade.score_percent,
      passed,
      passing_grade_percent,
      earned_points: grade.earned_points,
      total_points: grade.total_points,
      per_question: grade.per_question,
      state: { best_score_percent: nextBest, passed_at: nextPassedAt, last_submitted_attempt_id: attempt.id },
    },
    { status: 200 }
  );
}

