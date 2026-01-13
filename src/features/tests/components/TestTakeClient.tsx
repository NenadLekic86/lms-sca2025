"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, CheckCircle, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";

type TestRow = {
  id: string;
  title: string | null;
  max_attempts: number | null;
  pass_score: number | null;
};

type Question = {
  id: string;
  type: "true_false" | "single_choice" | "multi_choice";
  prompt: string;
  points: number;
  options: Array<{ id: string; text: string }>;
};

export function TestTakeClient({
  orgId,
  test,
  questions,
}: {
  orgId: string;
  test: TestRow;
  questions: Question[];
}) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [result, setResult] = useState<{ score: number; passed: boolean; pass_score: number } | null>(null);

  // answers: questionId -> optionIds
  const [answers, setAnswers] = useState<Record<string, string[]>>({});

  const canSubmit = useMemo(() => {
    if (!attemptId) return false;
    if (questions.length === 0) return false;
    // Require each question to have at least one selection.
    return questions.every((q) => (answers[q.id]?.length ?? 0) > 0);
  }, [answers, attemptId, questions]);

  async function startAttempt() {
    setStarting(true);
    try {
      const res = await fetch(`/api/tests/${test.id}/attempts/start`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { attempt?: { id?: string } | null; error?: string } | null;
      if (!res.ok) throw new Error(body?.error || "Failed to start attempt");
      const id = body?.attempt?.id ?? null;
      if (!id) throw new Error("Missing attempt id");
      setAttemptId(id);
      toast.success("Attempt started.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start attempt");
    } finally {
      setStarting(false);
    }
  }

  function toggleOption(q: Question, optionId: string, checked: boolean) {
    setAnswers((prev) => {
      const current = new Set(prev[q.id] ?? []);
      const isSingle = q.type === "single_choice" || q.type === "true_false";
      if (isSingle) {
        return { ...prev, [q.id]: checked ? [optionId] : [] };
      }
      if (checked) current.add(optionId);
      else current.delete(optionId);
      return { ...prev, [q.id]: Array.from(current) };
    });
  }

  async function submit() {
    if (!attemptId) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/test-attempts/${attemptId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; score?: number; passed?: boolean; pass_score?: number; error?: string }
        | null;
      if (!res.ok) throw new Error(body?.error || "Failed to submit");
      if (typeof body?.score !== "number" || typeof body?.passed !== "boolean" || typeof body?.pass_score !== "number") {
        throw new Error("Invalid response");
      }
      setResult({ score: body.score, passed: body.passed, pass_score: body.pass_score });
      toast.success("Submitted.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="space-y-6">
        <div className={`rounded-xl border p-6 ${result.passed ? "bg-green-50" : "bg-red-50"}`}>
          <div className="flex items-start gap-3">
            {result.passed ? <CheckCircle className="h-6 w-6 text-green-700" /> : <XCircle className="h-6 w-6 text-red-700" />}
            <div>
              <div className="text-xl font-semibold text-foreground">
                {result.passed ? "Passed" : "Not passed"}
              </div>
              <div className="text-sm text-muted-foreground">
                Score: <span className="font-medium text-foreground">{result.score}%</span> • Passing score:{" "}
                <span className="font-medium text-foreground">{result.pass_score}%</span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => router.push(`/org/${orgId}/my-tests`)}>
            Back to My Tests
          </Button>
          <Button onClick={() => router.push(`/org/${orgId}/my-courses`)}>
            Back to My Courses
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-5 flex items-start justify-between gap-4">
        <div>
          <div className="text-sm text-muted-foreground">Test</div>
          <div className="text-xl font-semibold text-foreground">{(test.title ?? "").trim() || "Assessment"}</div>
          <div className="text-sm text-muted-foreground">
            Passing score: <span className="font-medium text-foreground">{test.pass_score ?? 0}%</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!attemptId ? (
            <Button onClick={() => void startAttempt()} disabled={starting}>
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Start attempt
            </Button>
          ) : (
            <Button onClick={() => void submit()} disabled={!canSubmit || submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Submit
            </Button>
          )}
        </div>
      </div>

      {!attemptId ? (
        <div className="rounded-xl border bg-amber-50 p-5 text-sm text-amber-900">
          Click <strong>Start attempt</strong> to begin. Once started, select answers and submit.
        </div>
      ) : null}

      <div className="space-y-4">
        {questions.map((q, idx) => (
          <div key={q.id} className="rounded-xl border bg-card p-5 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="font-medium text-foreground">
                Q{idx + 1} • {q.type.replace("_", " ")} • {q.points} pts
              </div>
            </div>
            <div className="text-sm text-foreground whitespace-pre-wrap">{q.prompt}</div>

            <div className="space-y-2">
              {q.options.map((o) => {
                const isSingle = q.type === "single_choice" || q.type === "true_false";
                const checked = (answers[q.id] ?? []).includes(o.id);
                return (
                  <label key={o.id} className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 cursor-pointer hover:bg-muted/30">
                    <input
                      type={isSingle ? "radio" : "checkbox"}
                      name={`q-${q.id}`}
                      className="h-4 w-4 accent-primary"
                      checked={checked}
                      onChange={(e) => toggleOption(q, o.id, e.target.checked)}
                    />
                    <span className="text-sm text-foreground">{o.text}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

