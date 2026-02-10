"use client";

import { useEffect, useMemo, useState } from "react";
import { BookOpen, CalendarDays, ChevronRight, Clock, Building2, User, X, BadgeCheck, BadgeX } from "lucide-react";

import { HelpText } from "@/components/table-v2/controls";
import { useBodyScrollLock, useEscClose, useMountedForAnimation } from "@/components/table-v2/hooks";

export type EnrollmentResultV2 = "passed" | "failed" | "not_submitted" | null;

export type RecentEnrollmentItemV2 = {
  id: string;
  time: string; // already formatted for display (e.g. toLocaleString on server)
  organization?: string | null;
  user: string;
  course: string;

  result: EnrollmentResultV2;
  enrollmentStatus?: string | null;
  testTitle?: string | null;

  attemptCount?: number | null;
  submittedCount?: number | null;
  totalDurationSeconds?: number | null;
  latestAttemptDurationSeconds?: number | null;
  latestScore?: number | null;

  enrolledAt?: string | null;
  latestStartedAt?: string | null;
  latestSubmittedAt?: string | null;

  meta?: unknown;
};

function formatDurationSeconds(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatScore(score: number | null | undefined): string {
  if (typeof score !== "number" || !Number.isFinite(score)) return "—";
  return `${Math.round(score)}%`;
}

function ResultPill({ result }: { result: EnrollmentResultV2 }) {
  const r = result ?? "not_submitted";
  const label = r === "passed" ? "Passed" : r === "failed" ? "Failed" : "Not Submitted";
  const cls =
    r === "passed"
      ? "bg-green-100 text-green-800"
      : r === "failed"
        ? "bg-red-100 text-red-800"
        : "bg-gray-100 text-gray-800";
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

export function RecentEnrollmentsTableV2({
  items,
  emptyTitle = "No enrollments yet.",
  emptySubtitle,
  tip = "Tip: click any row to open details.",
}: {
  items: RecentEnrollmentItemV2[];
  emptyTitle?: string;
  emptySubtitle?: string;
  tip?: string;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerMounted = useMountedForAnimation(drawerOpen, 220);

  useEscClose(drawerOpen, () => setDrawerOpen(false));
  useBodyScrollLock(drawerOpen);

  const active = useMemo(() => (activeId ? items.find((i) => i.id === activeId) ?? null : null), [activeId, items]);

  return (
    <div className="space-y-3">
      <HelpText>{tip}</HelpText>

      {/* Desktop table */}
      <div className="hidden lg:block rounded-md border bg-background overflow-hidden">
        <div className="w-full overflow-x-auto">
          <table className="min-w-max w-full">
            <thead className="bg-background border-b">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground whitespace-nowrap">Time</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">User</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Course</th>
                <th className="px-4 py-3 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-10 text-center text-muted-foreground">
                    <div className="font-medium">{emptyTitle}</div>
                    {emptySubtitle ? <div className="text-sm mt-1">{emptySubtitle}</div> : null}
                  </td>
                </tr>
              ) : (
                items.map((it) => (
                  <tr
                    key={it.id}
                    className="group cursor-pointer hover:bg-muted/30 transition-colors"
                    onClick={() => {
                      setActiveId(it.id);
                      setDrawerOpen(true);
                    }}
                  >
                    <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">{it.time}</td>
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium text-foreground">{it.user}</div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium text-foreground">{it.course}</div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="sr-only">Open details</span>
                      <ChevronRight className="inline-block h-4 w-4 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="lg:hidden space-y-3">
        {items.length === 0 ? (
          <div className="rounded-lg border bg-background p-6 text-center text-sm text-muted-foreground">
            <div className="font-medium">{emptyTitle}</div>
            {emptySubtitle ? <div className="mt-1">{emptySubtitle}</div> : null}
          </div>
        ) : (
          items.map((it) => (
            <button
              key={it.id}
              type="button"
              className="w-full text-left rounded-lg border bg-background p-4 shadow-sm hover:bg-muted/20 transition-colors"
              onClick={() => {
                setActiveId(it.id);
                setDrawerOpen(true);
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground truncate">{it.course}</div>
                  <div className="mt-1 text-xs text-muted-foreground truncate">{it.user}</div>
                  <div className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    <span className="font-mono whitespace-nowrap">{it.time}</span>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </div>
            </button>
          ))
        )}
      </div>

      {/* Drawer */}
      {drawerMounted && active ? (
        <RecentEnrollmentDetailsDrawer
          key={active.id}
          open={drawerOpen}
          item={active}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}
    </div>
  );
}

function RecentEnrollmentDetailsDrawer({
  open,
  item,
  onClose,
}: {
  open: boolean;
  item: RecentEnrollmentItemV2;
  onClose: () => void;
}) {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 0);
    return () => window.clearTimeout(t);
  }, []);

  const show = open && entered;
  const attempts = `${item.submittedCount ?? 0} / ${item.attemptCount ?? 0}`;
  const totalTime = formatDurationSeconds(item.totalDurationSeconds);
  const latestTime = formatDurationSeconds(item.latestAttemptDurationSeconds);
  const latestScore = formatScore(item.latestScore);

  const ResultIcon = (item.result ?? "not_submitted") === "passed" ? BadgeCheck : (item.result ?? "not_submitted") === "failed" ? BadgeX : Clock;
  const resultLabel = (item.result ?? "not_submitted") === "passed" ? "Passed" : (item.result ?? "not_submitted") === "failed" ? "Failed" : "Not Submitted";

  return (
    <div className="fixed inset-0 z-100000" role="dialog" aria-modal="true" onClick={onClose}>
      <div className={`absolute inset-0 z-0 bg-black/40 transition-opacity duration-200 ${show ? "opacity-100" : "opacity-0"}`} />

      <div
        className={`
          fixed right-0 top-0 bottom-0 z-10 w-full max-w-[750px] bg-background shadow-2xl border-l flex flex-col
          transition-transform duration-200 ease-out
          ${show ? "translate-x-0" : "translate-x-full"}
          lg:right-6 lg:top-[30px] lg:bottom-6 lg:border lg:rounded-3xl
        `}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="h-16 px-6 flex items-center justify-between">
          <div className="text-md font-semibold text-foreground bg-muted-foreground/10 rounded-md px-6 py-2">Enrollment Details</div>
          <button
            type="button"
            aria-label="Close"
            className="inline-flex h-9 w-9 items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b" />

        <div className="flex-1 overflow-auto px-6 py-6 space-y-6">
          {/* Summary */}
          <div className="rounded-xl bg-muted/30 border p-5">
            <div className="text-lg font-semibold text-primary">{item.course}</div>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex items-start justify-between gap-4">
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  <User className="h-4 w-4" />
                  User
                </span>
                <span className="text-foreground text-right break-all">{item.user}</span>
              </div>

              {item.organization ? (
                <div className="flex items-start justify-between gap-4">
                  <span className="inline-flex items-center gap-2 text-muted-foreground">
                    <Building2 className="h-4 w-4" />
                    Organization
                  </span>
                  <span className="text-foreground text-right">{item.organization}</span>
                </div>
              ) : null}

              <div className="flex items-start justify-between gap-4">
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  <BookOpen className="h-4 w-4" />
                  Course
                </span>
                <span className="text-foreground text-right wrap-break-word">{item.course}</span>
              </div>

              <div className="flex items-start justify-between gap-4">
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  <CalendarDays className="h-4 w-4" />
                  Time
                </span>
                <span className="text-foreground text-right">{item.time}</span>
              </div>

              <div className="flex items-start justify-between gap-4">
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  <ResultIcon className="h-4 w-4" />
                  Result
                </span>
                <div className="text-right space-y-1">
                  <ResultPill result={item.result} />
                  <div className="text-xs text-muted-foreground">{resultLabel}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Metrics */}
          <div className="space-y-3">
            <div className="text-xl font-semibold text-foreground">Metrics</div>
            <div className="rounded-xl border bg-background p-5 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="rounded-lg border bg-muted/20 p-4">
                  <div className="text-xs text-muted-foreground">Attempts (submitted / total)</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">{attempts}</div>
                </div>
                <div className="rounded-lg border bg-muted/20 p-4">
                  <div className="text-xs text-muted-foreground">Latest score</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">{latestScore}</div>
                </div>
                <div className="rounded-lg border bg-muted/20 p-4">
                  <div className="text-xs text-muted-foreground">Total time</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">{totalTime}</div>
                </div>
                <div className="rounded-lg border bg-muted/20 p-4">
                  <div className="text-xs text-muted-foreground">Latest time</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">{latestTime}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Info */}
          <div className="space-y-3">
            <div className="text-xl font-semibold text-foreground">Info</div>
            <div className="rounded-xl border bg-background p-5 space-y-3 text-sm">
              {item.testTitle ? (
                <div className="flex items-start justify-between gap-4">
                  <span className="text-muted-foreground">Test</span>
                  <span className="text-foreground text-right wrap-break-word">{item.testTitle}</span>
                </div>
              ) : null}

              {item.enrollmentStatus ? (
                <div className="flex items-start justify-between gap-4">
                  <span className="text-muted-foreground">Enrollment status</span>
                  <span className="text-foreground text-right">{item.enrollmentStatus}</span>
                </div>
              ) : null}

              {item.latestStartedAt ? (
                <div className="flex items-start justify-between gap-4">
                  <span className="text-muted-foreground">Latest started</span>
                  <span className="text-foreground text-right">{new Date(item.latestStartedAt).toLocaleString()}</span>
                </div>
              ) : null}

              {item.latestSubmittedAt ? (
                <div className="flex items-start justify-between gap-4">
                  <span className="text-muted-foreground">Latest submitted</span>
                  <span className="text-foreground text-right">{new Date(item.latestSubmittedAt).toLocaleString()}</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

