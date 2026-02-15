"use client";

import { useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ClipboardList,
  ArrowDownUp,
  Brackets,
  CheckSquare,
  Image as ImageIcon,
  Images,
  Link2,
  ListChecks,
  MoreVertical,
  Pencil,
  Plus,
  TextCursorInput,
  ToggleLeft,
  Trash2,
  X,
} from "lucide-react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { RichTextEditorWithUploads } from "@/features/courses/components/v2/RichTextEditorWithUploads";
import { revokeInlineQueueObjectUrls, type InlineImageQueue } from "@/lib/richtext/inlineImages";

export type QuizWizardSavePayload = {
  title: string;
  payload_json: Record<string, unknown>;
  inline_images?: InlineImageQueue;
};

type QuizFeedbackMode = "default" | "reveal" | "retry";
type QuizTimeUnit = "seconds" | "minutes" | "hours";

export type QuizQuestionType =
  | "true_false"
  | "single_choice"
  | "multiple_choice"
  | "fill_in_the_blanks"
  | "short_answer"
  | "matching"
  | "image_matching"
  | "image_answering"
  | "ordering";

type QuizOptionDisplayFormat = "only_text" | "only_image" | "text_and_image_both";

type QuizOption = {
  id: string;
  title: string;
  image_data_url: string | null;
  display_format: QuizOptionDisplayFormat;
  position: number;
};

function isSupportedAnswerType(type: QuizQuestionType): type is "true_false" | "single_choice" | "multiple_choice" {
  return type === "true_false" || type === "single_choice" || type === "multiple_choice";
}

function applyQuestionTypeChange(prev: QuizQuestion, nextType: QuizQuestionType): QuizQuestion {
  if (prev.type === nextType) return prev;

  // Convert correctness state between types.
  if (nextType === "true_false") {
    return {
      ...prev,
      type: nextType,
      options: [],
      correct_option_id: null,
      correct_option_ids: [],
      correct_boolean: typeof prev.correct_boolean === "boolean" ? prev.correct_boolean : true,
    };
  }

  if (prev.type === "true_false") {
    // Moving from T/F to choice: keep question text/explanation, start with empty options.
    return {
      ...prev,
      type: nextType,
      options: [],
      correct_option_id: null,
      correct_option_ids: [],
      correct_boolean: undefined,
    };
  }

  // Moving between single/multi:
  const correctIds = Array.isArray(prev.correct_option_ids) ? prev.correct_option_ids.filter(Boolean) : [];
  const correctId = prev.correct_option_id ?? (correctIds[0] ?? null);
  if (nextType === "single_choice") {
    return {
      ...prev,
      type: nextType,
      correct_option_id: correctId,
      correct_option_ids: correctId ? [correctId] : [],
    };
  }
  if (nextType === "multiple_choice") {
    const nextIds = correctIds.length ? correctIds : correctId ? [correctId] : [];
    return {
      ...prev,
      type: nextType,
      correct_option_id: nextIds[0] ?? null,
      correct_option_ids: nextIds,
    };
  }

  // Other types (future): keep as-is for now.
  return { ...prev, type: nextType };
}

type QuizQuestion = {
  id: string;
  title: string;
  type: QuizQuestionType;
  answer_required: boolean;
  randomize: boolean;
  points: number;
  display_points: boolean;
  description_html: string;
  options: QuizOption[];
  correct_option_id: string | null;
  correct_option_ids?: string[];
  correct_boolean?: boolean;
  answer_explanation_html: string;
};

type QuizSettings = {
  time_limit_value: number;
  time_limit_unit: QuizTimeUnit;
  hide_quiz_time_display: boolean;
  feedback_mode: QuizFeedbackMode;
  attempts_allowed: number; // 0 = no limit
  passing_grade_percent: number;
  max_questions_allowed_to_answer: number;
};

type QuizV1Payload = {
  kind: "quiz_v1";
  title: string;
  summary: string;
  questions: QuizQuestion[];
  settings: QuizSettings;
};

function makeId(prefix: string) {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  }
}

function clampInt(v: number, min: number, max: number) {
  const n = Number.isFinite(v) ? Math.floor(v) : min;
  return Math.max(min, Math.min(max, n));
}

function normalizePayload(initial: Record<string, unknown> | null | undefined, fallbackTitle: string, fallbackSummary: string): QuizV1Payload {
  const base = (initial ?? {}) as Partial<QuizV1Payload>;
  const settings = (base.settings ?? {}) as Partial<QuizSettings>;
  const rawQuestions = Array.isArray(base.questions) ? (base.questions as Array<Record<string, unknown>>) : [];
  return {
    kind: "quiz_v1",
    title: typeof base.title === "string" ? base.title : fallbackTitle,
    summary: typeof base.summary === "string" ? base.summary : fallbackSummary,
    questions: rawQuestions.map((q) => {
      const type = (q.type as QuizQuestionType) || "single_choice";
      const options = Array.isArray(q.options) ? (q.options as QuizOption[]) : [];
      const correctIds = Array.isArray(q.correct_option_ids) ? (q.correct_option_ids as string[]).filter(Boolean) : [];
      const correctId = typeof q.correct_option_id === "string" ? q.correct_option_id : null;
      const correctBoolean = typeof q.correct_boolean === "boolean" ? q.correct_boolean : true;
      return {
        id: typeof q.id === "string" ? q.id : makeId("q"),
        title: typeof q.title === "string" ? q.title : "",
        type,
        answer_required: Boolean(q.answer_required ?? true),
        randomize: Boolean(q.randomize ?? false),
        points: clampInt(Number(q.points ?? 1), 0, 999),
        display_points: Boolean(q.display_points ?? false),
        description_html: typeof q.description_html === "string" ? q.description_html : "",
        options: options
          .slice()
          .map((o, idx) => ({
            id: typeof (o as { id?: unknown }).id === "string" ? String((o as { id: string }).id) : makeId("opt"),
            title: typeof (o as { title?: unknown }).title === "string" ? String((o as { title: string }).title) : "",
            image_data_url: typeof (o as { image_data_url?: unknown }).image_data_url === "string" ? String((o as { image_data_url: string }).image_data_url) : null,
            display_format:
              (o as { display_format?: unknown }).display_format === "only_image" ||
              (o as { display_format?: unknown }).display_format === "text_and_image_both"
                ? ((o as { display_format: QuizOptionDisplayFormat }).display_format as QuizOptionDisplayFormat)
                : "only_text",
            position: Number.isFinite(Number((o as { position?: unknown }).position)) ? Number((o as { position: number }).position) : idx,
          }))
          .sort((a, b) => a.position - b.position)
          .map((o, idx) => ({ ...o, position: idx })),
        correct_option_id: correctId,
        correct_option_ids: correctIds.length ? correctIds : correctId ? [correctId] : [],
        correct_boolean: correctBoolean,
        answer_explanation_html: typeof q.answer_explanation_html === "string" ? q.answer_explanation_html : "",
      } as QuizQuestion;
    }),
    settings: {
      time_limit_value: clampInt(Number(settings.time_limit_value ?? 0), 0, 9999),
      time_limit_unit: (settings.time_limit_unit === "seconds" || settings.time_limit_unit === "minutes" || settings.time_limit_unit === "hours"
        ? settings.time_limit_unit
        : "minutes") as QuizTimeUnit,
      hide_quiz_time_display: Boolean(settings.hide_quiz_time_display ?? false),
      feedback_mode: (settings.feedback_mode === "reveal" || settings.feedback_mode === "retry" ? settings.feedback_mode : "default") as QuizFeedbackMode,
      attempts_allowed: clampInt(Number(settings.attempts_allowed ?? 0), 0, 10),
      passing_grade_percent: clampInt(Number(settings.passing_grade_percent ?? 80), 0, 100),
      max_questions_allowed_to_answer: clampInt(Number(settings.max_questions_allowed_to_answer ?? 10), 1, 500),
    },
  };
}

const QUESTION_TYPE_OPTIONS: Array<{ id: QuizQuestionType; label: string }> = [
  { id: "true_false", label: "True/False" },
  { id: "single_choice", label: "Single choice" },
  { id: "multiple_choice", label: "Multiple Choice" },
  { id: "fill_in_the_blanks", label: "Fill In The Blanks" },
  { id: "short_answer", label: "Short Answer" },
  { id: "matching", label: "Matching" },
  { id: "image_matching", label: "Image Matching" },
  { id: "image_answering", label: "Image Answering" },
  { id: "ordering", label: "Ordering" },
];

function questionTypeMeta(type: QuizQuestionType): { label: string; icon: React.ReactNode; iconWrapClass: string } {
  const label = QUESTION_TYPE_OPTIONS.find((t) => t.id === type)?.label ?? type;
  switch (type) {
    case "true_false":
      return { label, icon: <ToggleLeft className="h-4 w-4" />, iconWrapClass: "bg-blue-500/10 text-blue-600" };
    case "single_choice":
      return { label, icon: <CheckSquare className="h-4 w-4" />, iconWrapClass: "bg-emerald-500/10 text-emerald-700" };
    case "multiple_choice":
      return { label, icon: <ListChecks className="h-4 w-4" />, iconWrapClass: "bg-violet-500/10 text-violet-700" };
    case "fill_in_the_blanks":
      return { label, icon: <Brackets className="h-4 w-4" />, iconWrapClass: "bg-amber-500/10 text-amber-800" };
    case "short_answer":
      return { label, icon: <TextCursorInput className="h-4 w-4" />, iconWrapClass: "bg-orange-500/10 text-orange-800" };
    case "matching":
      return { label, icon: <Link2 className="h-4 w-4" />, iconWrapClass: "bg-slate-500/10 text-slate-700" };
    case "image_matching":
      return { label, icon: <Images className="h-4 w-4" />, iconWrapClass: "bg-pink-500/10 text-pink-700" };
    case "image_answering":
      return { label, icon: <ImageIcon className="h-4 w-4" />, iconWrapClass: "bg-fuchsia-500/10 text-fuchsia-700" };
    case "ordering":
      return { label, icon: <ArrowDownUp className="h-4 w-4" />, iconWrapClass: "bg-indigo-500/10 text-indigo-700" };
    default:
      return { label, icon: <ClipboardList className="h-4 w-4" />, iconWrapClass: "bg-muted text-muted-foreground" };
  }
}

function Stepper({ step }: { step: 1 | 2 | 3 }) {
  const steps = [
    { n: 1, label: "Quiz Info" },
    { n: 2, label: "Question" },
    { n: 3, label: "Settings" },
  ] as const;

  return (
    <div className="px-5 pt-4">
      <div className="grid grid-cols-3 gap-2">
        {steps.map((s, idx) => {
          const done = step > s.n;
          const active = step === s.n;
          return (
            <div key={s.n} className="relative">
              {idx < steps.length - 1 ? (
                <div className="absolute top-3 left-1/2 w-full z-0 pointer-events-none">
                  <div className={cn("h-[2px] w-full", step > s.n ? "bg-primary" : "bg-muted")} />
                </div>
              ) : null}
              <div className="flex flex-col items-center gap-2">
                <div
                  className={cn(
                    "h-6 w-6 rounded-full border flex items-center justify-center text-xs font-semibold relative z-10 bg-background",
                    done ? "bg-primary text-primary-foreground border-primary" : active ? "bg-primary/10 text-primary border-primary" : "bg-background text-muted-foreground"
                  )}
                >
                  {done ? <Check className="h-4 w-4" /> : s.n}
                </div>
                <div className={cn("text-xs", active ? "text-foreground font-medium" : "text-muted-foreground")}>{s.label}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex items-center gap-2 text-sm select-none", disabled && "opacity-60")}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors p-[2px] overflow-hidden",
          checked ? "bg-primary border-primary" : "bg-muted border-border",
          disabled ? "cursor-not-allowed" : "cursor-pointer"
        )}
        aria-pressed={checked}
      >
        <span
          className={cn(
            "h-4 w-4 rounded-full bg-background shadow-sm transition-transform will-change-transform",
            checked ? "translate-x-4" : "translate-x-0"
          )}
        />
      </button>
      <span>{label}</span>
    </label>
  );
}

function SortableOptionRow({
  option,
  selectionMode,
  selected,
  onToggleSelected,
  onEdit,
  onDelete,
}: {
  option: QuizOption;
  selectionMode: "single" | "multi";
  selected: boolean;
  onToggleSelected: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: option.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("flex items-center justify-between rounded-md border bg-background px-3 py-2", isDragging && "opacity-70 shadow-md")}
    >
      <div className="min-w-0 flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleSelected}
          title={selectionMode === "multi" ? "Toggle correct" : "Mark as correct"}
          className={cn(
            "h-5 w-5 border flex items-center justify-center",
            selectionMode === "multi" ? "rounded-sm" : "rounded-full"
          )}
        >
          {selected ? (
            selectionMode === "multi" ? (
              <Check className="h-4 w-4 text-primary" />
            ) : (
              <span className="h-3 w-3 rounded-full bg-primary" />
            )
          ) : null}
        </button>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{option.title?.trim() || "(untitled option)"}</div>
          <div className="text-[11px] text-muted-foreground">
            {option.display_format === "only_text" ? "Only text" : option.display_format === "only_image" ? "Only image" : "Text & image"}
            {option.image_data_url ? " • image" : ""}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onEdit} title="Edit option">
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Drag to reorder"
          className="cursor-grab active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onDelete} title="Delete option">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function TrueFalseCorrectSelector({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="text-sm font-medium text-foreground">Correct answer</div>
      <div className="mt-3 flex items-center gap-3">
        <span className={cn("text-sm", !value ? "text-foreground font-medium" : "text-muted-foreground")}>False</span>
        <button
          type="button"
          onClick={() => onChange(!value)}
          className={cn(
            "relative inline-flex h-6 w-12 items-center rounded-full border transition-colors p-[2px] overflow-hidden cursor-pointer",
            value ? "bg-primary border-primary" : "bg-muted border-border"
          )}
          aria-pressed={value}
          title="Toggle correct answer"
        >
          <span className={cn("h-5 w-5 rounded-full bg-background shadow-sm transition-transform", value ? "translate-x-6" : "translate-x-0")} />
        </button>
        <span className={cn("text-sm", value ? "text-foreground font-medium" : "text-muted-foreground")}>True</span>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">Choose whether the correct answer is True or False.</div>
    </div>
  );
}

export function QuizWizardModal({
  mode,
  initialTitle,
  initialSummary,
  initialPayloadJson,
  onClose,
  onSave,
}: {
  mode: "create" | "edit";
  initialTitle: string;
  initialSummary: string;
  initialPayloadJson?: Record<string, unknown> | null;
  onClose: () => void;
  onSave: (payload: QuizWizardSavePayload) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const init = useMemo(() => normalizePayload(initialPayloadJson, initialTitle, initialSummary), [initialPayloadJson, initialSummary, initialTitle]);
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [title, setTitle] = useState(init.title ?? initialTitle);
  const [summary, setSummary] = useState(init.summary ?? initialSummary);
  const [questions, setQuestions] = useState<QuizQuestion[]>(init.questions ?? []);
  const [settings, setSettings] = useState<QuizSettings>(init.settings);

  const [editingQuestion, setEditingQuestion] = useState<QuizQuestion | null>(null);
  const [optionEditorId, setOptionEditorId] = useState<string | null>(null);
  const [questionTypeOpen, setQuestionTypeOpen] = useState(false);
  const [isOptionImageDragActive, setIsOptionImageDragActive] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [queuedInlineImages, setQueuedInlineImages] = useState<InlineImageQueue>({});

  const focusField = "focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-primary focus-visible:border-dashed focus-visible:outline-none";
  const focusWithinField = "focus-within:border-primary focus-within:border-dashed";
  const selectBase = "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none";
  const selectFocus = "focus:border-primary focus:border-dashed focus:ring-0 focus:outline-none";

  function upsertQuestion(q: QuizQuestion) {
    setQuestions((prev) => {
      const idx = prev.findIndex((x) => x.id === q.id);
      if (idx < 0) return [...prev, q];
      const next = prev.slice();
      next[idx] = q;
      return next;
    });
  }

  function removeQuestion(questionId: string) {
    setQuestions((prev) => prev.filter((q) => q.id !== questionId));
  }

  function goNext() {
    if (step === 1) {
      if (title.trim().length < 2) {
        toast.error("Quiz title must be at least 2 characters.");
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      // Allow no questions for now (can be enforced later).
      setStep(3);
      return;
    }
  }

  function closeAndCleanup() {
    revokeInlineQueueObjectUrls(queuedInlineImages ?? {});
    setQueuedInlineImages({});
    onClose();
  }

  function goBack() {
    if (editingQuestion) {
      setEditingQuestion(null);
      setOptionEditorId(null);
      return;
    }
    setStep((s) => (s === 1 ? 1 : ((s - 1) as 1 | 2 | 3)));
  }

  function finalizeSave() {
    if (title.trim().length < 2) {
      toast.error("Quiz title must be at least 2 characters.");
      setStep(1);
      return;
    }

    const payload: QuizV1Payload = {
      kind: "quiz_v1",
      title: title.trim(),
      summary: summary,
      questions,
      settings,
    };

    onSave({ title: payload.title, payload_json: payload as unknown as Record<string, unknown>, inline_images: queuedInlineImages });
    toast.success(mode === "create" ? "Quiz created." : "Quiz updated.");
    setQueuedInlineImages({});
    onClose();
  }

  function startNewQuestion() {
    setOptionEditorId(null);
    const q: QuizQuestion = {
      id: makeId("q"),
      title: "",
      type: "single_choice",
      answer_required: true,
      randomize: false,
      points: 1,
      display_points: false,
      description_html: "",
      options: [],
      correct_option_id: null,
      correct_option_ids: [],
      correct_boolean: true,
      answer_explanation_html: "",
    };
    setEditingQuestion(q);
  }

  async function uploadOptionImage(file: File) {
    if (!editingQuestion || !optionEditorId) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file.");
      return;
    }
    const maxBytes = 5 * 1024 * 1024;
    if (file.size > maxBytes) {
      toast.error("Image is too large (max 5MB).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) return;
      setEditingQuestion((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          options: prev.options.map((o) => (o.id === optionEditorId ? { ...o, image_data_url: dataUrl } : o)),
        };
      });
    };
    reader.readAsDataURL(file);
  }

  const content = (
    <div className="p-4 space-y-6 max-h-[70vh] overflow-auto bg-muted/10">
      {step === 1 ? (
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Quiz Title</label>
            <Input
              className={cn("mt-1", focusField)}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Type your quiz title here"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Summary</label>
            <Textarea
              className={cn("mt-1", focusField)}
              rows={8}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Write a short summary"
            />
          </div>
        </div>
      ) : step === 2 ? (
        <div className="space-y-4">
          {!editingQuestion ? (
            <>
              {questions.length ? (
                <div className="space-y-2">
                  {questions.map((q, idx) => (
                    <div key={q.id} className="rounded-md border bg-background px-3 py-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {idx + 1}. {q.title.trim() || "(untitled question)"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {QUESTION_TYPE_OPTIONS.find((t) => t.id === q.type)?.label ?? q.type}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditingQuestion(q)} title="Edit question">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeQuestion(q.id)} title="Delete question">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <Button type="button" variant="outline" onClick={startNewQuestion} className="w-fit gap-2">
                <Plus className="h-4 w-4" />
                Add Question
              </Button>
            </>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground cursor-pointer"
                  onClick={goBack}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </button>
              </div>

              <div>
                <label className="text-sm font-medium">Write your question here</label>
                <Input
                  className={cn("mt-1", focusField)}
                  value={editingQuestion.title}
                  onChange={(e) => setEditingQuestion((prev) => (prev ? { ...prev, title: e.target.value } : prev))}
                  placeholder="Question 1"
                />
              </div>

              <div>
                <label className="text-sm font-medium">Select your question type</label>
                <div className="relative mt-1">
                  {(() => {
                    const meta = questionTypeMeta(editingQuestion.type);
                    return (
                  <button
                    type="button"
                    className={cn(
                      "w-full h-10 rounded-md border bg-background px-3 text-sm flex items-center justify-between cursor-pointer",
                      focusField
                    )}
                    onClick={() => setQuestionTypeOpen((v) => !v)}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={cn("h-6 w-6 rounded-md flex items-center justify-center shrink-0", meta.iconWrapClass)}>
                        {meta.icon}
                      </span>
                      <span className="truncate">{meta.label}</span>
                    </span>
                    <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", questionTypeOpen ? "rotate-180" : "")} />
                  </button>
                    );
                  })()}

                  {questionTypeOpen ? (
                    <div className="absolute z-50 mt-2 w-full rounded-md border bg-card shadow-lg p-2">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {QUESTION_TYPE_OPTIONS.map((t) => {
                          const active = editingQuestion.type === t.id;
                          const meta = questionTypeMeta(t.id);
                          return (
                            <button
                              key={t.id}
                              type="button"
                              className={cn(
                                "rounded-md border px-3 py-2 text-sm text-left hover:bg-muted/10 transition-colors flex items-center gap-2 cursor-pointer",
                                active ? "border-primary bg-primary/5" : "bg-background"
                              )}
                              onClick={() => {
                                setEditingQuestion((prev) => (prev ? applyQuestionTypeChange(prev, t.id) : prev));
                                setQuestionTypeOpen(false);
                              }}
                            >
                              <span className={cn("h-7 w-7 rounded-md flex items-center justify-center shrink-0", meta.iconWrapClass)}>
                                {meta.icon}
                              </span>
                              <span className="font-medium">{meta.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap gap-6">
                <Toggle
                  checked={editingQuestion.answer_required}
                  onChange={(v) => setEditingQuestion((prev) => (prev ? { ...prev, answer_required: v } : prev))}
                  label="Answer Required"
                />
                <Toggle
                  checked={editingQuestion.randomize}
                  onChange={(v) => setEditingQuestion((prev) => (prev ? { ...prev, randomize: v } : prev))}
                  label="Randomize"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">Point(s) for this answer</label>
                  <Input
                    className={cn("mt-1", focusField)}
                    type="number"
                    min={0}
                    max={999}
                    value={editingQuestion.points}
                    onChange={(e) => setEditingQuestion((prev) => (prev ? { ...prev, points: clampInt(Number(e.target.value || 0), 0, 999) } : prev))}
                  />
                </div>
                <div className="flex items-end">
                  <Toggle
                    checked={editingQuestion.display_points}
                    onChange={(v) => setEditingQuestion((prev) => (prev ? { ...prev, display_points: v } : prev))}
                    label="Display Points"
                  />
                </div>
              </div>

              <div>
                <label className="text-sm font-medium">Description (Optional)</label>
                <div className="mt-2">
                  <RichTextEditorWithUploads
                    value={editingQuestion.description_html}
                    onChange={(html) => setEditingQuestion((prev) => (prev ? { ...prev, description_html: html } : prev))}
                    placeholder="Add more context for this question..."
                    minHeightClass="min-h-[160px]"
                    className={focusWithinField}
                    queue={queuedInlineImages}
                    setQueue={setQueuedInlineImages}
                  />
                </div>
              </div>

              <div className="space-y-3">
                {editingQuestion.type === "true_false" ? (
                  <>
                    <div className="text-sm font-medium text-foreground">Correct answer</div>
                    <TrueFalseCorrectSelector
                      value={typeof editingQuestion.correct_boolean === "boolean" ? editingQuestion.correct_boolean : true}
                      onChange={(v) => setEditingQuestion((prev) => (prev ? { ...prev, correct_boolean: v } : prev))}
                    />
                  </>
                ) : !isSupportedAnswerType(editingQuestion.type) ? (
                  <div className="rounded-md border bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                    This question type will be implemented later. For now, use True/False, Single choice, or Multiple Choice.
                  </div>
                ) : (
                  <>
                    <div className="text-sm font-medium text-foreground">Input options for the question and select the correct answer.</div>

                    {editingQuestion.options.length ? (
                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={(event: DragEndEvent) => {
                          const { active, over } = event;
                          if (!over || active.id === over.id) return;
                          setEditingQuestion((prev) => {
                            if (!prev) return prev;
                            const ordered = prev.options.slice().sort((a, b) => a.position - b.position);
                            const oldIndex = ordered.findIndex((o) => o.id === active.id);
                            const newIndex = ordered.findIndex((o) => o.id === over.id);
                            if (oldIndex < 0 || newIndex < 0) return prev;
                            const next = ordered.slice();
                            const [moved] = next.splice(oldIndex, 1);
                            next.splice(newIndex, 0, moved);
                            return { ...prev, options: next.map((o, idx) => ({ ...o, position: idx })) };
                          });
                        }}
                      >
                        <SortableContext items={editingQuestion.options.slice().sort((a, b) => a.position - b.position).map((o) => o.id)} strategy={verticalListSortingStrategy}>
                          <div className="space-y-2">
                            {editingQuestion.options
                              .slice()
                              .sort((a, b) => a.position - b.position)
                              .map((o) => {
                                const mode = editingQuestion.type === "multiple_choice" ? "multi" : "single";
                                const selected =
                                  mode === "multi"
                                    ? (editingQuestion.correct_option_ids ?? []).includes(o.id)
                                    : editingQuestion.correct_option_id === o.id;
                                return (
                                  <SortableOptionRow
                                    key={o.id}
                                    option={o}
                                    selectionMode={mode}
                                    selected={selected}
                                    onToggleSelected={() =>
                                      setEditingQuestion((prev) => {
                                        if (!prev) return prev;
                                        if (prev.type === "multiple_choice") {
                                          const set = new Set(prev.correct_option_ids ?? []);
                                          if (set.has(o.id)) set.delete(o.id);
                                          else set.add(o.id);
                                          const arr = [...set];
                                          return { ...prev, correct_option_ids: arr, correct_option_id: arr[0] ?? null };
                                        }
                                        return { ...prev, correct_option_id: o.id, correct_option_ids: [o.id] };
                                      })
                                    }
                                    onEdit={() => setOptionEditorId(o.id)}
                                    onDelete={() =>
                                      setEditingQuestion((prev) => {
                                        if (!prev) return prev;
                                        const filtered = prev.options.filter((x) => x.id !== o.id);
                                        const nextCorrectIds = (prev.correct_option_ids ?? []).filter((id) => id !== o.id);
                                        const nextCorrectId = prev.correct_option_id === o.id ? (nextCorrectIds[0] ?? null) : prev.correct_option_id;
                                        return {
                                          ...prev,
                                          correct_option_id: nextCorrectId,
                                          correct_option_ids: nextCorrectIds,
                                          options: filtered.map((x, idx) => ({ ...x, position: idx })),
                                        };
                                      })
                                    }
                                  />
                                );
                              })}
                          </div>
                        </SortableContext>
                      </DndContext>
                    ) : null}

                    <Button
                      type="button"
                      variant="outline"
                      className="w-fit gap-2"
                      onClick={() => {
                        const id = makeId("opt");
                        setEditingQuestion((prev) => {
                          if (!prev) return prev;
                          const next: QuizOption = {
                            id,
                            title: "",
                            image_data_url: null,
                            display_format: "only_text",
                            position: prev.options.length,
                          };
                          return { ...prev, options: [...prev.options, next] };
                        });
                        setOptionEditorId(id);
                      }}
                    >
                      <Plus className="h-4 w-4" />
                      Add An Option
                    </Button>
                  </>
                )}

                {optionEditorId ? (
                  <div className="rounded-lg border bg-background p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-semibold">Answer option</div>
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => setOptionEditorId(null)} title="Close">
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    <div>
                      <label className="text-sm font-medium">Answer Title</label>
                      <Input
                        className={cn("mt-1", focusField)}
                        value={editingQuestion.options.find((o) => o.id === optionEditorId)?.title ?? ""}
                        onChange={(e) =>
                          setEditingQuestion((prev) => {
                            if (!prev) return prev;
                            return {
                              ...prev,
                              options: prev.options.map((o) => (o.id === optionEditorId ? { ...o, title: e.target.value } : o)),
                            };
                          })
                        }
                        placeholder="Answer title"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium">Upload Image</label>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => fileInputRef.current?.click()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              fileInputRef.current?.click();
                            }
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            setIsOptionImageDragActive(true);
                          }}
                          onDragLeave={() => setIsOptionImageDragActive(false)}
                          onDrop={(e) => {
                            e.preventDefault();
                            setIsOptionImageDragActive(false);
                            const f = e.dataTransfer.files?.[0] ?? null;
                            if (f) void uploadOptionImage(f);
                          }}
                          className={cn(
                            "mt-2 h-[180px] cursor-pointer rounded-md border border-dashed flex items-center justify-center overflow-hidden bg-muted/10 transition-colors",
                            isOptionImageDragActive ? "border-primary bg-primary/5" : "",
                            "focus:outline-none focus-visible:ring-0 focus-visible:border-primary focus-visible:border-dashed"
                          )}
                        >
                          {editingQuestion.options.find((o) => o.id === optionEditorId)?.image_data_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={editingQuestion.options.find((o) => o.id === optionEditorId)?.image_data_url as string}
                              alt="Option image preview"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="px-3 text-center">
                              <p className="text-xs text-muted-foreground">Drop or choose image</p>
                              <p className="mt-1 text-[11px] text-muted-foreground">Click here or drag file into this area</p>
                            </div>
                          )}
                        </div>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0] ?? null;
                              if (f) void uploadOptionImage(f);
                              if (fileInputRef.current) fileInputRef.current.value = "";
                            }}
                          />
                        <div className="mt-2 text-xs text-muted-foreground">Recommended: 700×430 pixels</div>
                      </div>
                      <div>
                        <label className="text-sm font-medium">Display format for options</label>
                        <div className="mt-2 space-y-2 text-sm">
                          {(
                            [
                              ["only_text", "Only text"],
                              ["only_image", "Only Image"],
                              ["text_and_image_both", "Text & Image both"],
                            ] as Array<[QuizOptionDisplayFormat, string]>
                          ).map(([id, label]) => {
                            const current =
                              editingQuestion.options.find((o) => o.id === optionEditorId)?.display_format ?? "only_text";
                            return (
                              <label key={id} className="flex items-center gap-2">
                                <input
                                  type="radio"
                                  name="display_format"
                                  checked={current === id}
                                  onChange={() =>
                                    setEditingQuestion((prev) => {
                                      if (!prev) return prev;
                                      return {
                                        ...prev,
                                        options: prev.options.map((o) => (o.id === optionEditorId ? { ...o, display_format: id } : o)),
                                      };
                                    })
                                  }
                                />
                                {label}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    <div>
                      <Button type="button" onClick={() => setOptionEditorId(null)} className="w-fit">
                        Update Answer
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div>
                <label className="text-sm font-medium">Answer Explanation</label>
                <div className="mt-2">
                  <RichTextEditorWithUploads
                    value={editingQuestion.answer_explanation_html}
                    onChange={(html) => setEditingQuestion((prev) => (prev ? { ...prev, answer_explanation_html: html } : prev))}
                    placeholder="Write an explanation shown after answering..."
                    minHeightClass="min-h-[160px]"
                    className={focusWithinField}
                    queue={queuedInlineImages}
                    setQueue={setQueuedInlineImages}
                  />
                </div>
              </div>

              <div className="flex items-center justify-end pt-2">
                <Button
                  type="button"
                  className="gap-2"
                  onClick={() => {
                    if (!editingQuestion.title.trim()) {
                      toast.error("Question title is required.");
                      return;
                    }

                    if (!isSupportedAnswerType(editingQuestion.type)) {
                      toast.error("This question type is not supported yet. Please use True/False, Single choice, or Multiple Choice.");
                      return;
                    }

                    if (editingQuestion.type === "true_false") {
                      const normalized: QuizQuestion = {
                        ...editingQuestion,
                        options: [],
                        correct_option_id: null,
                        correct_option_ids: [],
                        correct_boolean: typeof editingQuestion.correct_boolean === "boolean" ? editingQuestion.correct_boolean : true,
                      };
                      upsertQuestion(normalized);
                      setEditingQuestion(null);
                      setOptionEditorId(null);
                      toast.success("Question added.");
                      return;
                    }

                    if (editingQuestion.options.length < 2) {
                      toast.error("Add at least 2 options.");
                      return;
                    }
                    if (editingQuestion.type === "single_choice") {
                      if (!editingQuestion.correct_option_id) {
                        toast.error("Select the correct answer.");
                        return;
                      }
                    } else if (editingQuestion.type === "multiple_choice") {
                      if (!(editingQuestion.correct_option_ids ?? []).length) {
                        toast.error("Select one or more correct answers.");
                        return;
                      }
                    }

                    const normalized: QuizQuestion = {
                      ...editingQuestion,
                      options: editingQuestion.options
                        .slice()
                        .sort((a, b) => a.position - b.position)
                        .map((o, idx) => ({ ...o, position: idx })),
                      correct_option_ids:
                        editingQuestion.type === "multiple_choice"
                          ? (editingQuestion.correct_option_ids ?? []).filter(Boolean)
                          : editingQuestion.correct_option_id
                            ? [editingQuestion.correct_option_id]
                            : [],
                      correct_boolean: undefined,
                    };
                    upsertQuestion(normalized);
                    setEditingQuestion(null);
                    setOptionEditorId(null);
                    toast.success("Question added.");
                  }}
                >
                  <Plus className="h-4 w-4" />
                  Add to Questions
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="w-full">
            <label className="text-sm font-medium">Time Limit</label>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Input
                type="number"
                min={0}
                max={9999}
                className={cn(focusField)}
                value={settings.time_limit_value}
                onChange={(e) => setSettings((prev) => ({ ...prev, time_limit_value: clampInt(Number(e.target.value || 0), 0, 9999) }))}
              />
              <select
                className={cn(selectBase, selectFocus)}
                value={settings.time_limit_unit}
                onChange={(e) => setSettings((prev) => ({ ...prev, time_limit_unit: e.target.value as QuizTimeUnit }))}
              >
                <option value="seconds">Seconds</option>
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
              </select>
              <div className="flex items-center">
                <Toggle
                  checked={settings.hide_quiz_time_display}
                  onChange={(v) => setSettings((prev) => ({ ...prev, hide_quiz_time_display: v }))}
                  label="Hide quiz time - display"
                />
              </div>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">0 means no time limit.</div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">Quiz Feedback Mode</div>
            <div className="text-xs text-muted-foreground">(Pick the quiz system&apos;s behaviour on choice based questions.)</div>
            {(
              [
                ["default", "Default", "Answers shown after quiz is finished"],
                ["reveal", "Reveal Mode", "Show result after the attempt."],
                ["retry", "Retry Mode", "Reattempt quiz any number of times. Define Attempts Allowed below."],
              ] as Array<[QuizFeedbackMode, string, string]>
            ).map(([id, label, desc]) => (
              <label key={id} className={cn("flex items-start gap-3 rounded-lg border bg-background p-3 cursor-pointer", settings.feedback_mode === id ? "border-primary" : "")}>
                <input
                  type="radio"
                  name="feedback_mode"
                  checked={settings.feedback_mode === id}
                  onChange={() => setSettings((prev) => ({ ...prev, feedback_mode: id }))}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-xs text-muted-foreground">{desc}</div>
                </div>
              </label>
            ))}
          </div>

          <div className={cn(settings.feedback_mode !== "retry" && "opacity-60")}>
            <div className="text-sm font-medium">Attempts Allowed</div>
            <div className="mt-2 flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={10}
                value={settings.attempts_allowed}
                disabled={settings.feedback_mode !== "retry"}
                onChange={(e) => setSettings((prev) => ({ ...prev, attempts_allowed: clampInt(Number(e.target.value || 0), 0, 10) }))}
                className="w-full"
              />
              <div className="w-10 h-8 rounded-md bg-primary text-primary-foreground flex items-center justify-center text-sm font-semibold">
                {settings.attempts_allowed}
              </div>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Restriction on the number of attempts a student is allowed to take for this quiz. 0 for no limit.
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Passing Grade (%)</label>
              <Input
                type="number"
                min={0}
                max={100}
                value={settings.passing_grade_percent}
                className={cn("mt-2", focusField)}
                onChange={(e) => setSettings((prev) => ({ ...prev, passing_grade_percent: clampInt(Number(e.target.value || 0), 0, 100) }))}
              />
              <div className="mt-1 text-xs text-muted-foreground">Set the passing percentage for this quiz</div>
            </div>
            <div>
              <label className="text-sm font-medium">Max Question Allowed to Answer</label>
              <Input
                className={cn("mt-2", focusField)}
                type="number"
                min={1}
                max={500}
                value={settings.max_questions_allowed_to_answer}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, max_questions_allowed_to_answer: clampInt(Number(e.target.value || 10), 1, 500) }))
                }
              />
              <div className="mt-1 text-xs text-muted-foreground">
                This amount of question will be available for members to answer, and questions will come randomly from all available questions belongs with a quiz, if this amount is greater then available question, then all questions will be available for a member to answer.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-1000 bg-black/50 p-4 sm:p-6 overflow-y-auto" data-leave-guard-ignore="true">
      <div className="min-h-[calc(100svh-2rem)] sm:min-h-[calc(100svh-3rem)] flex items-center justify-center">
        <div className="w-full max-w-4xl rounded-lg border bg-card shadow-xl overflow-hidden">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-primary" />
              <h3 className="font-semibold">Quiz</h3>
            </div>
            <Button type="button" size="icon-sm" variant="ghost" onClick={closeAndCleanup}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <Stepper step={step} />

          {content}

          <div className="flex items-center justify-between border-t px-4 py-3 bg-background">
            <Button type="button" variant="outline" onClick={closeAndCleanup}>
              Cancel
            </Button>

            <div className="flex items-center gap-2">
              {step > 1 ? (
                <Button type="button" variant="outline" onClick={goBack}>
                  Back
                </Button>
              ) : null}

              {step < 3 ? (
                <Button type="button" onClick={goNext}>
                  Save & Next
                </Button>
              ) : (
                <Button type="button" onClick={finalizeSave}>
                  Save
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

