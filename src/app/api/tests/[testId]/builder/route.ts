import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { validateSchema } from "@/lib/validations/schemas";
import { z } from "zod";
import crypto from "crypto";

export const runtime = "nodejs";

type QuestionRow = {
  id: string;
  type: "true_false" | "single_choice" | "multi_choice";
  prompt: string;
  points: number;
};

type OptionRow = {
  question_id: string;
  text: string;
  is_correct: boolean;
};

const optionSchema = z.object({
  text: z.string().trim().min(1, "Option text is required").max(500),
  is_correct: z.boolean().default(false),
});

const questionSchema = z.object({
  type: z.enum(["true_false", "single_choice", "multi_choice"]),
  prompt: z.string().trim().min(2, "Question prompt is required").max(5000),
  points: z.number().int().min(1).max(100).default(1),
  options: z.array(optionSchema).min(2, "At least 2 options are required").max(10),
});

const builderSchema = z.object({
  test: z
    .object({
      title: z.string().trim().min(2).max(200).optional(),
      max_attempts: z.number().int().min(1).max(50).optional(),
      pass_score: z.number().min(0).max(100).optional(),
    })
    .optional(),
  questions: z.array(questionSchema).max(200),
});

async function canManageTest(params: {
  caller: { id: string; role: string; organization_id: string | null };
  testId: string;
}) {
  const admin = createAdminSupabaseClient();
  const { data: testRow, error: testError } = await admin
    .from("tests")
    .select("id, course_id, organization_id")
    .eq("id", params.testId)
    .single();

  if (testError || !testRow) return { ok: false as const, status: 404, error: testError?.message || "Test not found" };

  if (!["super_admin", "system_admin", "organization_admin"].includes(params.caller.role)) {
    return { ok: false as const, status: 403, error: "Forbidden" };
  }

  if (params.caller.role === "organization_admin") {
    if (!params.caller.organization_id || testRow.organization_id !== params.caller.organization_id) {
      return { ok: false as const, status: 403, error: "Forbidden" };
    }
  }

  return { ok: true as const, admin, testRow };
}

export async function GET(_request: NextRequest, context: { params: Promise<{ testId: string }> }) {
  const { testId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Use session client for reading so RLS works later for members.
  const supabase = await createServerSupabaseClient();
  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id, title, course_id, organization_id, is_published, max_attempts, pass_score")
    .eq("id", testId)
    .single();

  if (testError || !test) return NextResponse.json({ error: testError?.message || "Test not found" }, { status: 404 });

  const { data: questionsData, error: qError } = await supabase
    .from("test_questions")
    .select("id, test_id, position, type, prompt, points")
    .eq("test_id", testId)
    .order("position", { ascending: true });

  if (qError) return NextResponse.json({ error: qError.message }, { status: 500 });

  const rawQuestions = (Array.isArray(questionsData) ? questionsData : []) as Array<Record<string, unknown>>;
  const questions: QuestionRow[] = rawQuestions
    .map((q) => {
      const id = typeof q.id === "string" ? q.id : null;
      const type = q.type;
      const prompt = typeof q.prompt === "string" ? q.prompt : null;
      const points = typeof q.points === "number" ? q.points : 1;
      if (!id || !prompt) return null;
      if (type !== "true_false" && type !== "single_choice" && type !== "multi_choice") return null;
      return { id, type, prompt, points };
    })
    .filter((v): v is QuestionRow => Boolean(v));

  const questionIds = questions.map((q) => q.id);

  let optionsByQuestion: Record<string, OptionRow[]> = {};
  if (questionIds.length > 0) {
    const { data: opts, error: oError } = await supabase
      .from("test_question_options")
      .select("id, question_id, position, text, is_correct")
      .in("question_id", questionIds)
      .order("position", { ascending: true });

    if (oError) return NextResponse.json({ error: oError.message }, { status: 500 });

    optionsByQuestion = {};
    const rawOpts = (Array.isArray(opts) ? opts : []) as Array<Record<string, unknown>>;
    for (const o of rawOpts) {
      const qid = typeof o.question_id === "string" ? o.question_id : null;
      const text = typeof o.text === "string" ? o.text : "";
      const is_correct = Boolean(o.is_correct);
      if (!qid) continue;
      optionsByQuestion[qid] = optionsByQuestion[qid] || [];
      optionsByQuestion[qid].push({ question_id: qid, text, is_correct });
    }
  }

  const builder = questions.map((q) => ({
    type: q.type,
    prompt: q.prompt,
    points: q.points,
    options: (optionsByQuestion[String(q.id)] || []).map((o) => ({
      text: o.text,
      is_correct: Boolean(o.is_correct),
    })),
  }));

  return NextResponse.json({ test, questions: builder }, { status: 200 });
}

export async function PUT(request: NextRequest, context: { params: Promise<{ testId: string }> }) {
  const { testId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const perm = await canManageTest({ caller, testId });
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: perm.status });

  const body = await request.json().catch(() => null);
  const validation = validateSchema(builderSchema, body);
  if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });

  const admin = perm.admin;
  const payload = validation.data;

  // Update test settings (optional)
  if (payload.test && Object.keys(payload.test).length > 0) {
    const { error: tErr } = await admin
      .from("tests")
      .update(payload.test)
      .eq("id", testId);
    if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
  }

  // Replace strategy: delete all questions (options cascade)
  const { error: delError } = await admin.from("test_questions").delete().eq("test_id", testId);
  if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });

  // Insert questions with server-generated IDs
  const questionsToInsert = payload.questions.map((q, idx) => ({
    id: crypto.randomUUID(),
    test_id: testId,
    position: idx + 1,
    type: q.type,
    prompt: q.prompt,
    points: q.points,
  }));

  if (questionsToInsert.length > 0) {
    const { error: insQErr } = await admin.from("test_questions").insert(questionsToInsert);
    if (insQErr) return NextResponse.json({ error: insQErr.message }, { status: 500 });

    const optionsToInsert: Array<{
      id: string;
      question_id: string;
      position: number;
      text: string;
      is_correct: boolean;
    }> = [];

    payload.questions.forEach((q, idx) => {
      const qid = questionsToInsert[idx].id;
      q.options.forEach((opt, oidx) => {
        optionsToInsert.push({
          id: crypto.randomUUID(),
          question_id: qid,
          position: oidx + 1,
          text: opt.text,
          is_correct: opt.is_correct,
        });
      });
    });

    if (optionsToInsert.length > 0) {
      const { error: insOErr } = await admin.from("test_question_options").insert(optionsToInsert);
      if (insOErr) return NextResponse.json({ error: insOErr.message }, { status: 500 });
    }
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "update_test_builder",
      entity: "tests",
      entity_id: testId,
      metadata: { questions: payload.questions.length },
    });
  } catch {
    // ignore
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

