"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle, FileText, PlayCircle, ExternalLink, ClipboardList } from "lucide-react";

import { Button } from "@/components/ui/button";

type ResourceRow = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
};

type VideoRow = {
  id: string;
  original_url: string;
  embed_url: string | null;
  title: string | null;
  provider: string | null;
};

type ProgressRow = {
  item_type: "resource" | "video";
  item_id: string;
  completed_at: string | null;
};

function formatBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function CourseLearnClient({
  orgId,
  courseId,
  courseTitle,
  resources,
  videos,
  initialProgress,
}: {
  orgId: string;
  courseId: string;
  courseTitle: string;
  resources: ResourceRow[];
  videos: VideoRow[];
  initialProgress: ProgressRow[];
}) {
  const router = useRouter();

  const [progress, setProgress] = useState<ProgressRow[]>(initialProgress);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const completedSet = useMemo(() => {
    const s = new Set<string>();
    for (const p of progress) {
      if (p.completed_at) s.add(`${p.item_type}:${p.item_id}`);
    }
    return s;
  }, [progress]);

  const totalItems = resources.length + videos.length;
  const completedItems = useMemo(() => {
    let n = 0;
    for (const r of resources) if (completedSet.has(`resource:${r.id}`)) n++;
    for (const v of videos) if (completedSet.has(`video:${v.id}`)) n++;
    return n;
  }, [completedSet, resources, videos]);

  const percent = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
  const canBeginTest = totalItems > 0 && completedItems >= totalItems;

  async function toggleItem(item_type: "resource" | "video", item_id: string, completed: boolean) {
    const key = `${item_type}:${item_id}`;
    setBusyKey(key);
    try {
      const res = await fetch(`/api/courses/${courseId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_type, item_id, completed }),
      });
      const body = (await res.json().catch(() => null)) as { row?: ProgressRow; error?: string } | null;
      if (!res.ok) throw new Error(body?.error || "Failed to update progress");

      // Merge the updated row into local state
      const row = body?.row ?? null;
      if (!row) return;
      setProgress((prev) => {
        const next = prev.filter((p) => !(p.item_type === row.item_type && p.item_id === row.item_id));
        next.push(row);
        return next;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update progress");
    } finally {
      setBusyKey(null);
    }
  }

  async function openPdf(resourceId: string) {
    setBusyKey(`resource-open:${resourceId}`);
    try {
      const res = await fetch(`/api/courses/${courseId}/resources/${resourceId}/signed-url`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { signedUrl?: string; error?: string } | null;
      if (!res.ok || !body?.signedUrl) throw new Error(body?.error || "Failed to open resource");

      window.open(body.signedUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to open resource");
    } finally {
      setBusyKey(null);
    }
  }

  async function beginTest() {
    try {
      if (!canBeginTest) {
        toast.info("Complete all course items first.");
        return;
      }

      const res = await fetch(`/api/courses/${courseId}/test`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { test?: { id?: string | null; is_published?: boolean | null } | null; error?: string };
      if (!res.ok) throw new Error(body?.error || "Failed to load test");

      const testId = body?.test?.id ?? null;
      if (!testId) {
        toast.info("No test is available for this course yet.");
        return;
      }
      if (body?.test?.is_published !== true) {
        toast.info("This test is not published yet.");
        return;
      }

      router.push(`/org/${orgId}/tests/${testId}/take`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start test");
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm text-muted-foreground">Learning</div>
            <div className="text-xl font-semibold text-foreground">{courseTitle}</div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => router.push(`/org/${orgId}/courses/${courseId}`)}>
              Back to course
            </Button>
            <Button onClick={() => void beginTest()} disabled={!canBeginTest}>
              <ClipboardList className="h-4 w-4" />
              Begin Test
            </Button>
          </div>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Progress</span>
            <span className="font-medium text-foreground">
              {completedItems}/{totalItems} • {percent}%
            </span>
          </div>
          <div className="mt-2 w-full h-2 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${percent}%` }} />
          </div>
          {!canBeginTest ? (
            <div className="mt-2 text-xs text-muted-foreground">
              Mark all PDFs/videos as complete to unlock the test.
            </div>
          ) : (
            <div className="mt-2 text-xs text-green-700">Ready for the test.</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <div className="text-lg font-semibold text-foreground">Resources (PDF)</div>
          {resources.length === 0 ? (
            <div className="text-sm text-muted-foreground">No resources yet.</div>
          ) : (
            <div className="space-y-2">
              {resources.map((r) => {
                const key = `resource:${r.id}`;
                const checked = completedSet.has(key);
                const busy = busyKey === key || busyKey === `resource-open:${r.id}`;
                return (
                  <div key={r.id} className="rounded-lg border bg-background p-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <div className="text-sm font-medium text-foreground truncate">{r.file_name}</div>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{formatBytes(r.size_bytes)}</div>
                      <button
                        type="button"
                        className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        onClick={() => void openPdf(r.id)}
                        disabled={busy}
                      >
                        Open PDF <ExternalLink className="h-3 w-3" />
                      </button>
                    </div>

                    <label className="inline-flex items-center gap-2 text-sm select-none">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={checked}
                        disabled={busy}
                        onChange={(e) => void toggleItem("resource", r.id, e.target.checked)}
                      />
                      Done
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border bg-card p-5 space-y-4">
          <div className="text-lg font-semibold text-foreground">Videos</div>
          {videos.length === 0 ? (
            <div className="text-sm text-muted-foreground">No videos yet.</div>
          ) : (
            <div className="space-y-4">
              {videos.map((v) => {
                const key = `video:${v.id}`;
                const checked = completedSet.has(key);
                const busy = busyKey === key;
                const title = v.title ?? (v.provider ? `${v.provider} video` : "Video");
                return (
                  <div key={v.id} className="rounded-xl border bg-background p-3 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <PlayCircle className="h-4 w-4 text-muted-foreground" />
                          <div className="text-sm font-medium text-foreground truncate">{title}</div>
                        </div>
                        <a
                          href={v.original_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          Open source <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>

                      <label className="inline-flex items-center gap-2 text-sm select-none">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={checked}
                          disabled={busy}
                          onChange={(e) => void toggleItem("video", v.id, e.target.checked)}
                        />
                        Done
                      </label>
                    </div>

                    {v.embed_url ? (
                      <div className="relative w-full aspect-video overflow-hidden rounded-lg border">
                        <iframe
                          src={v.embed_url}
                          className="absolute inset-0 h-full w-full"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                        />
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        Preview not available (private/invalid). Use “Open source”.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {canBeginTest ? (
        <div className="rounded-xl border bg-green-50 p-5 flex items-start gap-3">
          <CheckCircle className="h-5 w-5 text-green-700 mt-0.5" />
          <div>
            <div className="font-medium text-green-900">You’re ready</div>
            <div className="text-sm text-green-800">
              All course items are completed. You can begin the test now.
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

