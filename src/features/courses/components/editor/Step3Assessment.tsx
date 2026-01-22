import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/lib/api";

type TestRow = {
  id: string;
  title: string | null;
  max_attempts: number | null;
  pass_score: number | null;
};

type BuilderQuestion = {
  type: "true_false" | "single_choice" | "multi_choice";
  prompt: string;
  points: number;
  options: Array<{ text: string; is_correct: boolean }>;
};

export function Step3Assessment({
  courseId,
  onCompletionChange,
}: {
  courseId: string;
  onCompletionChange: (ok: boolean) => void;
}) {
  const [test, setTest] = useState<TestRow | null>(null);
  const [questions, setQuestions] = useState<BuilderQuestion[]>([]);
  const [questionCount, setQuestionCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isComplete = useMemo(() => questions.length > 0, [questions.length]);
  useEffect(() => {
    onCompletionChange(isComplete);
  }, [isComplete, onCompletionChange]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { data: body } = await fetchJson<{ test?: TestRow | null; questionCount?: number }>(`/api/courses/${courseId}/test`, {
        cache: "no-store",
      });

      setTest(body.test ?? null);
      setQuestionCount(typeof body.questionCount === "number" ? body.questionCount : 0);

      if (body.test?.id) {
        const { data: b2 } = await fetchJson<{ test?: TestRow; questions?: BuilderQuestion[] }>(`/api/tests/${body.test.id}/builder`, {
          cache: "no-store",
        });
        setQuestions(Array.isArray(b2.questions) ? b2.questions : []);
        setTest((prev) => (prev ? { ...prev, ...(b2.test ?? {}) } : (b2.test ?? null)));
      } else {
        setQuestions([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load assessment");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  async function createTest() {
    setLoading(true);
    setError(null);
    try {
      await fetchJson<{ test: TestRow }>(`/api/courses/${courseId}/test`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create assessment");
    } finally {
      setLoading(false);
    }
  }

  function addQuestion(type: BuilderQuestion["type"]) {
    const base: BuilderQuestion =
      type === "true_false"
        ? {
            type,
            prompt: "",
            points: 1,
            options: [
              { text: "True", is_correct: true },
              { text: "False", is_correct: false },
            ],
          }
        : {
            type,
            prompt: "",
            points: 1,
            options: [
              { text: "Option A", is_correct: true },
              { text: "Option B", is_correct: false },
            ],
          };
    setQuestions((prev) => [...prev, base]);
  }

  function removeQuestion(idx: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== idx));
  }

  function setOptionCorrect(qi: number, oi: number, isCorrect: boolean) {
    setQuestions((prev) =>
      prev.map((q, i) => {
        if (i !== qi) return q;
        const isSingle = q.type === "single_choice" || q.type === "true_false";
        return {
          ...q,
          options: q.options.map((o, j) => {
            if (j !== oi) return isSingle ? { ...o, is_correct: false } : o;
            return { ...o, is_correct: isCorrect };
          }),
        };
      })
    );
  }

  function addOption(qi: number) {
    setQuestions((prev) =>
      prev.map((q, i) => {
        if (i !== qi) return q;
        if (q.type === "true_false") return q;
        if (q.options.length >= 10) return q;
        return { ...q, options: [...q.options, { text: `Option ${q.options.length + 1}`, is_correct: false }] };
      })
    );
  }

  function removeOption(qi: number, oi: number) {
    setQuestions((prev) =>
      prev.map((q, i) => {
        if (i !== qi) return q;
        if (q.type === "true_false") return q;
        if (q.options.length <= 2) return q;
        return { ...q, options: q.options.filter((_, j) => j !== oi) };
      })
    );
  }

  async function saveBuilder() {
    if (!test?.id) return;
    setSaving(true);
    setError(null);
    try {
      await fetchJson<Record<string, unknown>>(`/api/tests/${test.id}/builder`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          test: {
            title: (test.title ?? "").trim() || undefined,
            max_attempts: typeof test.max_attempts === "number" ? test.max_attempts : undefined,
            pass_score: typeof test.pass_score === "number" ? test.pass_score : undefined,
          },
          questions,
        }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save assessment");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="rounded-lg border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-semibold text-foreground">Add Assessment (Test)</div>
            <p className="text-sm text-muted-foreground">
              Step 3 is required before publishing: add at least one question.
            </p>
          </div>

          {!test ? (
            <Button onClick={() => void createTest()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create assessment
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => void saveBuilder()} disabled={saving || loading}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save assessment
            </Button>
          )}
        </div>

        {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : null}

        {test ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2 md:col-span-2">
              <Label>Test title</Label>
              <Input
                value={test.title ?? ""}
                onChange={(e) => setTest((prev) => (prev ? { ...prev, title: e.target.value } : prev))}
                placeholder="Assessment title"
              />
            </div>
            <div className="space-y-2">
              <Label>Max attempts</Label>
              <Input
                type="number"
                min={1}
                max={50}
                value={test.max_attempts ?? 1}
                onChange={(e) => setTest((prev) => (prev ? { ...prev, max_attempts: Number(e.target.value || 1) } : prev))}
              />
            </div>
            <div className="space-y-2">
              <Label>Pass score (%)</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={test.pass_score ?? 0}
                onChange={(e) => setTest((prev) => (prev ? { ...prev, pass_score: Number(e.target.value || 0) } : prev))}
              />
            </div>
            <div className="text-xs text-muted-foreground md:col-span-2">
              Current saved questions: {questionCount}
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            No assessment created yet.
          </div>
        )}
      </div>

      {test ? (
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="font-medium text-foreground">Questions</div>
          </div>

          {questions.length === 0 ? (
            <div className="text-sm text-muted-foreground">No questions yet. Add your first question below.</div>
          ) : (
            <div className="space-y-4">
              {questions.map((q, qi) => {
                const isSingle = q.type === "single_choice" || q.type === "true_false";
                return (
                  <div key={qi} className="rounded-md border bg-background p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-sm font-medium text-foreground">
                        Q{qi + 1} — {q.type.replace("_", " ")}
                      </div>
                      <Button variant="ghost" size="icon-sm" onClick={() => removeQuestion(qi)} aria-label="Remove question">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div className="md:col-span-2 space-y-2">
                        <Label>Prompt</Label>
                        <Textarea
                          value={q.prompt}
                          onChange={(e) =>
                            setQuestions((prev) =>
                              prev.map((x, i) => (i === qi ? { ...x, prompt: e.target.value } : x))
                            )
                          }
                          placeholder="Write your question…"
                          maxLength={5000}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Points</Label>
                        <Input
                          type="number"
                          min={1}
                          max={100}
                          value={q.points}
                          onChange={(e) =>
                            setQuestions((prev) =>
                              prev.map((x, i) => (i === qi ? { ...x, points: Number(e.target.value || 1) } : x))
                            )
                          }
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>Answers</Label>
                        <Button variant="ghost" size="sm" onClick={() => addOption(qi)} disabled={q.type === "true_false"}>
                          + Add option
                        </Button>
                      </div>

                      <div className="space-y-2">
                        {q.options.map((o, oi) => (
                          <div key={oi} className="flex items-center gap-2">
                            <input
                              type={isSingle ? "radio" : "checkbox"}
                              name={`correct-${qi}`}
                              className="h-4 w-4 accent-primary"
                              checked={o.is_correct}
                              onChange={(e) => setOptionCorrect(qi, oi, e.target.checked)}
                            />
                            <Input
                              value={o.text}
                              disabled={q.type === "true_false"}
                              onChange={(e) =>
                                setQuestions((prev) =>
                                  prev.map((x, i) => {
                                    if (i !== qi) return x;
                                    return {
                                      ...x,
                                      options: x.options.map((oo, j) => (j === oi ? { ...oo, text: e.target.value } : oo)),
                                    };
                                  })
                                )
                              }
                            />
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => removeOption(qi, oi)}
                              disabled={q.type === "true_false" || q.options.length <= 2}
                              aria-label="Remove option"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>

                      <div className="text-xs text-muted-foreground">
                        {q.type === "multi_choice"
                          ? "Multiple correct answers allowed."
                          : "Only one correct answer."}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="pt-4 border-t flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="text-sm text-muted-foreground">Add another question</div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => addQuestion("true_false")}>
                + True/False
              </Button>
              <Button variant="outline" onClick={() => addQuestion("single_choice")}>
                + Single choice
              </Button>
              <Button variant="outline" onClick={() => addQuestion("multi_choice")}>
                + Multiple choice
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

