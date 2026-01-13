import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ClipboardList } from "lucide-react";

import { Button } from "@/components/ui/button";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { TestTakeClient } from "@/features/tests/components/TestTakeClient";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";

export const fetchCache = "force-no-store";

type TestRow = {
  id: string;
  title: string | null;
  is_published: boolean | null;
  max_attempts: number | null;
  pass_score: number | null;
};

type QuestionRow = {
  id: string;
  test_id: string;
  type: "true_false" | "single_choice" | "multi_choice";
  prompt: string;
  points: number;
};

type OptionRow = {
  id: string;
  question_id: string;
  text: string;
  position: number;
};

export default async function TakeTestPage({
  params,
}: {
  params: Promise<{ orgId: string; testId: string }>;
}) {
  const { user, error } = await getServerUser();
  if (error || !user) redirect("/");

  const { orgId: orgKey, testId } = await params;
  const resolved = await resolveOrgKey(orgKey);
  const org = resolved.org;
  if (!org) {
    if (user.role === "organization_admin" || user.role === "member") redirect("/unauthorized");
    notFound();
  }
  const orgSlug = org.slug;

  // Member-only taking flow (admins have builder pages).
  if (user.role !== "member") {
    redirect(`/org/${orgSlug}/my-tests`);
  }

  const supabase = await createServerSupabaseClient();

  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id, title, is_published, max_attempts, pass_score")
    .eq("id", testId)
    .single();

  if (testError || !test) redirect(`/org/${orgSlug}/my-tests`);
  if ((test as TestRow).is_published !== true) redirect(`/org/${orgSlug}/my-tests`);

  const { data: questionsData, error: qError } = await supabase
    .from("test_questions")
    .select("id, test_id, position, type, prompt, points")
    .eq("test_id", testId)
    .order("position", { ascending: true });

  if (qError) redirect(`/org/${orgSlug}/my-tests`);

  const questions = (Array.isArray(questionsData) ? questionsData : []) as QuestionRow[];
  const questionIds = questions.map((q) => q.id);

  const { data: optsData, error: oError } = questionIds.length
    ? await supabase
        .from("test_question_options")
        .select("id, question_id, position, text")
        .in("question_id", questionIds)
        .order("position", { ascending: true })
    : { data: [], error: null };

  if (oError) redirect(`/org/${orgSlug}/my-tests`);

  const options = (Array.isArray(optsData) ? optsData : []) as OptionRow[];
  const optionsByQ: Record<string, Array<{ id: string; text: string }>> = {};
  for (const o of options) {
    optionsByQ[o.question_id] = optionsByQ[o.question_id] || [];
    optionsByQ[o.question_id].push({ id: o.id, text: o.text });
  }

  const clientQuestions = questions.map((q) => ({
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    points: q.points,
    options: optionsByQ[q.id] || [],
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <ClipboardList className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Take test</h1>
            <p className="text-muted-foreground">{(test as TestRow).title ?? "Assessment"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href={`/org/${orgSlug}/my-tests`}>Back</Link>
          </Button>
        </div>
      </div>

      <TestTakeClient orgId={orgSlug} test={test as TestRow} questions={clientQuestions} />
    </div>
  );
}

