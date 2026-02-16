import { NextRequest } from "next/server";

import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { sanitizeRichHtml } from "@/lib/courses/sanitize.server";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({ request, caller: null, outcome: "error", status: 401, code: "UNAUTHORIZED", publicMessage: "Unauthorized" });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }
  if (caller.role !== "member" || !caller.organization_id) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const supabase = await createServerSupabaseClient();

  const { data: attempt, error: attemptError } = await supabase
    .from("course_v2_quiz_attempts")
    .select("id, organization_id, course_id, user_id, item_id, attempt_number, started_at, submitted_at, status")
    .eq("id", attemptId)
    .maybeSingle();
  if (attemptError || !attempt?.id) return apiError("NOT_FOUND", "Attempt not found.", { status: 404 });
  if (String((attempt as { user_id?: unknown }).user_id ?? "") !== String(caller.id)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  if (String((attempt as { organization_id?: unknown }).organization_id ?? "") !== String(caller.organization_id)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const courseId = String((attempt as { course_id?: unknown }).course_id ?? "");
  const itemId = String((attempt as { item_id?: unknown }).item_id ?? "");
  if (!courseId || !itemId) return apiError("NOT_FOUND", "Attempt not found.", { status: 404 });

  const [{ data: result }, { data: item }, { data: course }] = await Promise.all([
    supabase
      .from("course_v2_quiz_attempt_results")
      .select("graded_at, score_percent, passed, earned_points, total_points, result_json")
      .eq("attempt_id", attemptId)
      .maybeSingle(),
    supabase
      .from("course_topic_items")
      .select("id, title, course_id, item_type, payload_json")
      .eq("id", itemId)
      .maybeSingle(),
    supabase.from("courses").select("id, title, slug").eq("id", courseId).maybeSingle(),
  ]);

  if (!item?.id || String((item as { course_id?: unknown }).course_id ?? "") !== courseId || String((item as { item_type?: unknown }).item_type ?? "") !== "quiz") {
    return apiError("NOT_FOUND", "Quiz not found.", { status: 404 });
  }

  const payload = (item as { payload_json?: unknown }).payload_json;
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const summary_html = sanitizeRichHtml(typeof p.summary === "string" ? p.summary : "") ?? "";
  const settings = p.settings && typeof p.settings === "object" ? (p.settings as Record<string, unknown>) : {};
  const feedback_mode =
    settings.feedback_mode === "reveal" || settings.feedback_mode === "retry" ? String(settings.feedback_mode) : "default";

  const rawQuestions = Array.isArray(p.questions) ? (p.questions as unknown[]) : [];
  const questions = rawQuestions
    .map((q) => {
      if (!q || typeof q !== "object") return null;
      const qq = q as Record<string, unknown>;
      const id = typeof qq.id === "string" ? qq.id : "";
      if (!id) return null;
      const title = typeof qq.title === "string" ? qq.title : "";
      const type = typeof qq.type === "string" ? qq.type : "";
      const description_html = sanitizeRichHtml(typeof qq.description_html === "string" ? qq.description_html : "") ?? "";
      const answer_explanation_html = sanitizeRichHtml(typeof qq.answer_explanation_html === "string" ? qq.answer_explanation_html : "") ?? "";
      return { id, title, type, description_html, answer_explanation_html };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  const per_question = (() => {
    const base = (result && typeof (result as { result_json?: unknown }).result_json === "object"
      ? ((result as { result_json: Record<string, unknown> }).result_json ?? {})
      : {}) as Record<string, unknown>;
    const arr = Array.isArray(base.per_question) ? (base.per_question as unknown[]) : [];
    return arr
      .map((x) => {
        if (!x || typeof x !== "object") return null;
        const xx = x as Record<string, unknown>;
        const question_id = typeof xx.question_id === "string" ? xx.question_id : "";
        if (!question_id) return null;
        const correct = Boolean(xx.correct ?? false);
        const earned_points = Number.isFinite(Number(xx.earned_points)) ? Number(xx.earned_points) : 0;
        const points = Number.isFinite(Number(xx.points)) ? Number(xx.points) : 0;
        const missing = Boolean(xx.missing ?? false);
        return { question_id, correct, earned_points, points, missing };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
  })();

  const passing_grade_percent = Number.isFinite(Number((settings as { passing_grade_percent?: unknown }).passing_grade_percent))
    ? Math.max(0, Math.min(100, Math.floor(Number((settings as { passing_grade_percent: number }).passing_grade_percent))))
    : 80;

  if (!result?.graded_at) {
    // Attempt exists but no submitted result (e.g. abandoned/in-progress) — still return basic info.
    return apiOk(
      {
        attempt: {
          id: attemptId,
          attempt_number: (attempt as { attempt_number?: unknown }).attempt_number ?? null,
          started_at: typeof (attempt as { started_at?: unknown }).started_at === "string" ? (attempt as { started_at: string }).started_at : null,
          submitted_at: typeof (attempt as { submitted_at?: unknown }).submitted_at === "string" ? (attempt as { submitted_at: string }).submitted_at : null,
        },
        result: {
          graded_at: "",
          score_percent: 0,
          passed: false,
          passing_grade_percent,
          earned_points: 0,
          total_points: 0,
          per_question: [],
        },
        quiz: {
          id: itemId,
          title: typeof (item as { title?: unknown }).title === "string" ? String((item as { title: string }).title) : "Quiz",
          summary_html,
          questions,
          settings: { feedback_mode: feedback_mode as "default" | "reveal" | "retry" },
        },
        course: {
          id: courseId,
          title: typeof (course as { title?: unknown }).title === "string" ? String((course as { title: string }).title) : "Course",
          slug: typeof (course as { slug?: unknown }).slug === "string" ? String((course as { slug: string }).slug) : null,
        },
      },
      { status: 200 }
    );
  }

  return apiOk(
    {
      attempt: {
        id: attemptId,
        attempt_number: Number.isFinite(Number((attempt as { attempt_number?: unknown }).attempt_number))
          ? Number((attempt as { attempt_number: number }).attempt_number)
          : null,
        started_at: typeof (attempt as { started_at?: unknown }).started_at === "string" ? (attempt as { started_at: string }).started_at : null,
        submitted_at: typeof (attempt as { submitted_at?: unknown }).submitted_at === "string" ? (attempt as { submitted_at: string }).submitted_at : null,
      },
      result: {
        graded_at: typeof (result as { graded_at?: unknown }).graded_at === "string" ? (result as { graded_at: string }).graded_at : "",
        score_percent: Number.isFinite(Number((result as { score_percent?: unknown }).score_percent)) ? Number((result as { score_percent: number }).score_percent) : 0,
        passed: Boolean((result as { passed?: unknown }).passed ?? false),
        passing_grade_percent,
        earned_points: Number.isFinite(Number((result as { earned_points?: unknown }).earned_points)) ? Number((result as { earned_points: number }).earned_points) : 0,
        total_points: Number.isFinite(Number((result as { total_points?: unknown }).total_points)) ? Number((result as { total_points: number }).total_points) : 0,
        per_question,
      },
      quiz: {
        id: itemId,
        title: typeof (item as { title?: unknown }).title === "string" ? String((item as { title: string }).title) : "Quiz",
        summary_html,
        questions,
        settings: { feedback_mode: feedback_mode as "default" | "reveal" | "retry" },
      },
      course: {
        id: courseId,
        title: typeof (course as { title?: unknown }).title === "string" ? String((course as { title: string }).title) : "Course",
        slug: typeof (course as { slug?: unknown }).slug === "string" ? String((course as { slug: string }).slug) : null,
      },
    },
    { status: 200 }
  );
}

