"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, Check, ChevronLeft, ChevronRight, Flag, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { Step1CourseInfo } from "@/features/courses/components/editor/Step1CourseInfo";
import { Step2Resources } from "@/features/courses/components/editor/Step2Resources";
import { Step3Assessment } from "@/features/courses/components/editor/Step3Assessment";
import { Step4Publish } from "@/features/courses/components/editor/Step4Publish";
import { fetchJson } from "@/lib/api";
import type { Role } from "@/types";

type VisibilityScope = "all" | "organizations";

export type CourseEditorCourse = {
  id: string;
  title: string | null;
  description: string | null;
  excerpt: string | null;
  is_published: boolean | null;
  visibility_scope: VisibilityScope | null;
  cover_image_url: string | null;
  organization_id: string | null;
};

export function CourseEditorForm({
  mode,
  actorRole,
  orgId,
  backHref,
  course,
  initialOrganizationIds,
}: {
  mode: "create" | "edit";
  actorRole: Role;
  orgId?: string;
  backHref: string;
  course?: CourseEditorCourse;
  initialOrganizationIds?: string[];
}) {
  const router = useRouter();

  const canManageVisibility = actorRole === "super_admin" || actorRole === "system_admin";
  const isOrgAdmin = actorRole === "organization_admin";

  const [title, setTitle] = useState(course?.title ?? "");
  const [excerpt, setExcerpt] = useState(course?.excerpt ?? "");
  const [description, setDescription] = useState(course?.description ?? "");
  const [isPublished, setIsPublished] = useState<boolean>(course?.is_published ?? false);

  const [visibilityScope, setVisibilityScope] = useState<VisibilityScope>(
    (course?.visibility_scope ?? (isOrgAdmin ? "organizations" : "organizations")) as VisibilityScope
  );

  const [selectedOrgIds, setSelectedOrgIds] = useState<string[]>(initialOrganizationIds ?? []);

  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingCover, setIsUploadingCover] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeStep, setActiveStep] = useState<"info" | "resources" | "assessment" | "publish">("info");

  const [resourcesOk, setResourcesOk] = useState(false);
  const [assessmentOk, setAssessmentOk] = useState(false);
  const [publishStepOk, setPublishStepOk] = useState(false);

  const infoOk = useMemo(() => title.trim().length >= 2, [title]);
  const infoDirty = useMemo(() => {
    if (mode !== "edit") return false;
    if (!course) return title.trim().length > 0 || excerpt.trim().length > 0 || description.trim().length > 0;
    return (
      title.trim() !== (course.title ?? "").trim() ||
      excerpt.trim() !== (course.excerpt ?? "").trim() ||
      description.trim() !== (course.description ?? "").trim()
    );
  }, [course, description, excerpt, mode, title]);

  // Stepper connector: measure the circle centers so the line starts at Step 1 circle center
  // and ends at the last step circle center (pixel-perfect, responsive, no magic numbers).
  const stepperWrapRef = useRef<HTMLDivElement | null>(null);
  const stepCircleRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [stepperConnector, setStepperConnector] = useState<
    { left: number; top: number; width: number; progressScale: number } | null
  >(null);

  const computeStepperConnector = useCallback(() => {
    const wrap = stepperWrapRef.current;
    if (!wrap) {
      setStepperConnector(null);
      return;
    }

    const circles = stepCircleRefs.current;
    const nonNullCenters = circles
      .map((el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })
      .filter(Boolean) as Array<{ x: number; y: number }>;

    if (nonNullCenters.length < 2) {
      setStepperConnector(null);
      return;
    }

    const wrapRect = wrap.getBoundingClientRect();
    const centersByIndex = circles.map((el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    // Hide the connector if the stepper wraps into multiple rows.
    const minY = Math.min(...nonNullCenters.map((p) => p.y));
    const maxY = Math.max(...nonNullCenters.map((p) => p.y));
    if (maxY - minY > 8) {
      setStepperConnector(null);
      return;
    }

    const firstIndex = centersByIndex.findIndex((c) => Boolean(c));
    const lastIndex = centersByIndex.findLastIndex((c) => Boolean(c));
    if (firstIndex < 0 || lastIndex < 0) {
      setStepperConnector(null);
      return;
    }

    const first = centersByIndex[firstIndex]!;
    const last = centersByIndex[lastIndex]!;

    const activeIndexMap: Record<typeof activeStep, number> = {
      info: 0,
      resources: 1,
      assessment: 2,
      publish: 3,
    };
    const activeIndexRaw = activeIndexMap[activeStep] ?? 0;
    const activeIndex = Math.min(Math.max(activeIndexRaw, firstIndex), lastIndex);
    const active = (centersByIndex[activeIndex] ?? first) as { x: number; y: number };

    const width = Math.max(0, last.x - first.x);
    const progress = Math.min(Math.max(0, active.x - first.x), width);

    setStepperConnector({
      left: first.x - wrapRect.left,
      top: first.y - wrapRect.top,
      width,
      progressScale: width > 0 ? progress / width : 0,
    });
  }, [activeStep]);
  const visibilityOk = useMemo(() => {
    if (!canManageVisibility) return true;
    if (visibilityScope !== "organizations") return true;
    return selectedOrgIds.length > 0;
  }, [canManageVisibility, selectedOrgIds.length, visibilityScope]);

  const canPublishNow = useMemo(() => {
    // Step 4 completion includes certificate template + visibility selection.
    return infoOk && resourcesOk && assessmentOk && publishStepOk && visibilityOk;
  }, [assessmentOk, infoOk, publishStepOk, resourcesOk, visibilityOk]);

  const validateClient = (): string | null => {
    if (!title || title.trim().length < 2) return "Title must be at least 2 characters.";
    if (excerpt && excerpt.trim().length > 280) return "Excerpt must be at most 280 characters.";
    return null;
  };

  const patchCourse = async (payload: Record<string, unknown>) => {
    if (!course?.id) throw new Error("Missing course");
    await fetchJson<Record<string, unknown>>(`/api/courses/${course.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    router.refresh();
  };

  const saveCourseInfo = async (): Promise<boolean> => {
    setError(null);
    const clientError = validateClient();
    if (clientError) {
      setError(clientError);
      return false;
    }

    setIsSaving(true);
    try {
      if (mode === "create") {
        const payload: Record<string, unknown> = {
          title: title.trim(),
          excerpt: excerpt.trim(),
          description: description.trim(),
          // Visibility can be set later in the Publish step.
          visibility_scope: canManageVisibility ? "organizations" : "organizations",
        };

        const { data: json } = await fetchJson<{ course_id: string }>("/api/courses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const id = String(json?.course_id || "");
        if (!id) throw new Error("Missing course id");

        if (isOrgAdmin && orgId) {
          router.push(`/org/${orgId}/courses/${id}/edit`);
          return true;
        }
        if (actorRole === "super_admin") {
          router.push(`/admin/courses/${id}/edit`);
          return true;
        }
        if (actorRole === "system_admin") {
          router.push(`/system/courses/${id}/edit`);
          return true;
        }
        router.push(backHref);
        return true;
      }

      await patchCourse({
        title: title.trim(),
        excerpt: excerpt.trim(),
        description: description.trim(),
      });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const uploadCover = async () => {
    if (!course?.id) return;
    if (!coverFile) {
      setError("Choose an image to upload.");
      return;
    }
    setError(null);
    setIsUploadingCover(true);
    try {
      const form = new FormData();
      form.append("file", coverFile);
      await fetchJson<Record<string, unknown>>(`/api/courses/${course.id}/cover`, { method: "POST", body: form });
      setCoverFile(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload cover image");
    } finally {
      setIsUploadingCover(false);
    }
  };

  const savePublishSettings = async (): Promise<boolean> => {
    if (mode !== "edit") return false;
    setError(null);
    if (isPublished && !canPublishNow) {
      setError("Cannot publish yet: complete Resources, Assessment, and Certificate steps first.");
      return false;
    }
    setIsSaving(true);
    try {
      const payload: Record<string, unknown> = {
        is_published: Boolean(isPublished),
      };
      if (canManageVisibility) {
        payload.visibility_scope = visibilityScope;
        if (visibilityScope === "organizations") {
          payload.organization_ids = selectedOrgIds;
        }
      }
      await patchCourse(payload);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save publish settings";
      setError(msg);
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  // Load completion status even if user doesn't visit steps 2/3/4.
  useEffect(() => {
    if (mode !== "edit") return;
    if (!course?.id) return;
    const courseId = course.id;
    let cancelled = false;

    async function loadCompletion() {
      try {
        const [{ data: rBody }, { data: vBody }, { data: tBody }, { data: cBody }] = await Promise.all([
          fetchJson<{ resources?: Array<unknown> }>(`/api/courses/${courseId}/resources`, { cache: "no-store" }),
          fetchJson<{ videos?: Array<{ embed_url?: unknown }> }>(`/api/courses/${courseId}/videos`, { cache: "no-store" }),
          fetchJson<{ questionCount?: number }>(`/api/courses/${courseId}/test`, { cache: "no-store" }),
          fetchJson<{ template?: unknown }>(`/api/courses/${courseId}/certificate-template`, { cache: "no-store" }),
        ]);

        if (cancelled) return;

        const hasPdf = Array.isArray(rBody.resources) && rBody.resources.length > 0;
        const hasValidVideo =
          Array.isArray(vBody.videos) && vBody.videos.some((v) => typeof v.embed_url === "string" && v.embed_url.length > 0);
        setResourcesOk(hasPdf || hasValidVideo);

        setAssessmentOk(typeof tBody.questionCount === "number" ? tBody.questionCount > 0 : false);

        setPublishStepOk(Boolean(cBody.template));
      } catch {
        // ignore (best-effort indicators)
      }
    }

    void loadCompletion();
    return () => {
      cancelled = true;
    };
  }, [course?.id, mode]);

  const headerTitle = mode === "create" ? "Create course" : "Course Builder";
  const headerSubtitle =
    mode === "create"
      ? "Step 1 creates the draft. Then continue with the remaining steps."
      : "Complete the steps in order. Publishing is locked until all required steps are done.";

  const steps = useMemo(
    () => [
      { key: "info" as const, label: "Course Info", enabled: true, done: infoOk },
      { key: "resources" as const, label: "Resources", enabled: mode === "edit", done: resourcesOk },
      { key: "assessment" as const, label: "Assessment", enabled: mode === "edit", done: assessmentOk },
      { key: "publish" as const, label: "Certificate & Publish", enabled: mode === "edit", done: publishStepOk && visibilityOk },
    ],
    [assessmentOk, infoOk, mode, publishStepOk, resourcesOk, visibilityOk]
  );

  const enabledStepKeys = useMemo(() => steps.filter((s) => s.enabled).map((s) => s.key), [steps]);
  const activeIndex = useMemo(() => enabledStepKeys.indexOf(activeStep), [activeStep, enabledStepKeys]);
  const prevStepKey = activeIndex > 0 ? enabledStepKeys[activeIndex - 1] : null;
  const nextStepKey = activeIndex >= 0 && activeIndex < enabledStepKeys.length - 1 ? enabledStepKeys[activeIndex + 1] : null;

  const canGoPrev = Boolean(prevStepKey) && mode === "edit";
  const canGoNext = Boolean(nextStepKey) && mode === "edit";
  const isLastEnabledStep = mode === "edit" && !nextStepKey;

  const goPrev = () => {
    if (!prevStepKey) return;
    setActiveStep(prevStepKey);
  };

  const goNext = async () => {
    setError(null);

    // Create mode behaves like a wizard: "Next" == create draft & continue.
    if (mode === "create") {
      void saveCourseInfo();
      return;
    }

    // Edit mode: ensure Step 1 doesn't lose local edits when using Next.
    if (activeStep === "info") {
      const ok = await saveCourseInfo();
      if (!ok) return;
    }

    if (!nextStepKey) return;
    setActiveStep(nextStepKey);
  };

  const finishAndSave = async () => {
    if (mode !== "edit") return;
    const ok = await savePublishSettings();
    if (ok) {
      toast.success("Saved successfully.");
    }
  };

  useLayoutEffect(() => {
    computeStepperConnector();
  }, [activeStep, computeStepperConnector, steps]);

  useEffect(() => {
    computeStepperConnector();
    const wrap = stepperWrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => computeStepperConnector());
    ro.observe(wrap);
    window.addEventListener("resize", computeStepperConnector);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", computeStepperConnector);
    };
  }, [computeStepperConnector]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <BookOpen className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">{headerTitle}</h1>
            <p className="text-muted-foreground">{headerSubtitle}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href={backHref}>Back</Link>
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <Tabs
        value={activeStep}
        onValueChange={(v) => {
          const next = v as typeof activeStep;
          // NOTE: Tabs onValueChange isn't async-friendly; we gate step changes via an IIFE.
          void (async () => {
            if (mode === "edit" && activeStep === "info" && next !== "info" && infoDirty) {
              const ok = await saveCourseInfo();
              if (!ok) return;
            }
            setActiveStep(next);
          })();
        }}
        className="gap-4"
      >
        <div ref={stepperWrapRef} className="relative rounded-2xl border bg-card p-4 shadow-sm">
          {stepperConnector ? (
            <>
              {/* Base connector (behind tiles + circles, above card background) */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute hidden md:block z-0 h-px bg-border"
                style={{
                  left: `${stepperConnector.left}px`,
                  top: `${stepperConnector.top}px`,
                  width: `${stepperConnector.width}px`,
                }}
              />
              {/* Filled progress connector (up to active step) */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute hidden md:block z-0 h-px bg-primary rounded-full transform-gpu origin-left transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                style={{
                  left: `${stepperConnector.left}px`,
                  top: `${stepperConnector.top}px`,
                  width: `${stepperConnector.width}px`,
                  transform: `scaleX(${stepperConnector.progressScale})`,
                }}
              />
            </>
          ) : null}

          <TabsList className="relative z-10 w-full h-auto grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3 bg-transparent p-0">
            {steps.map((s, idx) => (
              <TabsTrigger
                key={s.key}
                value={s.key}
                disabled={!s.enabled}
                className={cn(
                  "group relative z-10 flex flex-col items-center justify-center gap-1.5 rounded-xl border bg-background/40 px-3 py-3 text-center transition",
                  "hover:bg-muted/30 hover:border-border",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  "disabled:opacity-50 disabled:pointer-events-none",
                  "data-[state=active]:bg-primary/10 data-[state=active]:border-primary/30 data-[state=active]:shadow-sm"
                )}
              >
                <span
                  ref={(el) => {
                    stepCircleRefs.current[idx] = el;
                  }}
                  className={cn(
                    "relative z-50 inline-flex h-9 w-9 items-center justify-center rounded-full border text-sm font-semibold",
                    "bg-background text-foreground",
                    "group-data-[state=active]:bg-primary group-data-[state=active]:border-primary group-data-[state=active]:text-primary-foreground",
                    s.done && "border-primary/40 bg-[#DEE9E4] text-primary"
                  )}
                >
                  {s.done ? <Check className="h-4 w-4" /> : idx + 1}
                </span>
                <span
                  className={cn(
                    "relative z-10 text-sm font-medium leading-tight text-foreground",
                    "group-data-[state=active]:text-foreground",
                    s.done && "text-muted-foreground"
                  )}
                >
                  {s.label}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="info">
          <Step1CourseInfo
            mode={mode}
            title={title}
            setTitle={setTitle}
            excerpt={excerpt}
            setExcerpt={setExcerpt}
            description={description}
            setDescription={setDescription}
            coverImageUrl={course?.cover_image_url ?? null}
            coverFile={coverFile}
            setCoverFile={setCoverFile}
            isUploadingCover={isUploadingCover}
            isSavingCourse={isSaving}
            onSaveCourseInfo={() => void saveCourseInfo()}
            onUploadCover={() => void uploadCover()}
            hidePrimaryActions
          />
        </TabsContent>

        <TabsContent value="resources">
          {mode === "edit" && course?.id ? (
            <Step2Resources courseId={course.id} onCompletionChange={setResourcesOk} />
          ) : (
            <div className="rounded-md border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              Create the draft first to add resources.
            </div>
          )}
        </TabsContent>

        <TabsContent value="assessment">
          {mode === "edit" && course?.id ? (
            <Step3Assessment courseId={course.id} onCompletionChange={setAssessmentOk} />
          ) : (
            <div className="rounded-md border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              Create the draft first to add an assessment.
            </div>
          )}
        </TabsContent>

        <TabsContent value="publish">
          {mode === "edit" && course?.id ? (
            <Step4Publish
              courseId={course.id}
              actorRole={actorRole}
              canManageVisibility={canManageVisibility}
              visibilityScope={visibilityScope}
              setVisibilityScope={setVisibilityScope}
              selectedOrgIds={selectedOrgIds}
              setSelectedOrgIds={setSelectedOrgIds}
              isPublished={isPublished}
              setIsPublished={setIsPublished}
              canPublishNow={canPublishNow}
              onCompletionChange={setPublishStepOk}
              onSavePublishSettings={() => void savePublishSettings()}
              hideSaveButton
            />
          ) : (
            <div className="rounded-md border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              Create the draft first to publish.
            </div>
          )}
        </TabsContent>

        {/* Footer navigation: wizard (create) vs builder (edit). */}
        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
          {mode === "create" ? (
            <Button variant="outline" asChild>
              <Link href={backHref}>Cancel</Link>
            </Button>
          ) : (
            <>
              {canGoPrev ? (
                <Button variant="outline" onClick={goPrev}>
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
              ) : (
                // Keep right-side actions aligned on desktop, but hide Previous entirely on Step 1.
                <div className="hidden sm:block h-9 w-[110px]" />
              )}
            </>
          )}

          <div className="flex items-center justify-end gap-2">
            {mode === "edit" && activeStep === "info" ? (
              <Button variant="secondary" onClick={() => void saveCourseInfo()} disabled={isSaving || isUploadingCover || !infoDirty}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save draft
              </Button>
            ) : null}

            {mode === "edit" && canGoNext ? (
              <Button onClick={() => void goNext()} disabled={isSaving || isUploadingCover}>
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            ) : null}

            {mode === "edit" && isLastEnabledStep ? (
              <Button onClick={() => void finishAndSave()} disabled={isSaving || isUploadingCover}>
                <Flag className="h-4 w-4" />
                Finish and Save
              </Button>
            ) : null}

            {mode === "create" ? (
              <Button onClick={() => void goNext()} disabled={isSaving || isUploadingCover}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
                Create draft & continue
              </Button>
            ) : null}
          </div>
        </div>
      </Tabs>
    </div>
  );
}

