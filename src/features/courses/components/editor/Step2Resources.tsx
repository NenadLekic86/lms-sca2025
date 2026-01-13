import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Loader2, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ResourceRow = {
  id: string;
  created_at: string;
  file_name: string;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  title?: string | null;
};

type VideoRow = {
  id: string;
  created_at: string;
  provider: string | null;
  original_url: string;
  embed_url: string | null;
  title: string | null;
  thumbnail_url: string | null;
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

export function Step2Resources({
  courseId,
  onCompletionChange,
}: {
  courseId: string;
  onCompletionChange: (ok: boolean) => void;
}) {
  const [resources, setResources] = useState<ResourceRow[]>([]);
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const [videoUrl, setVideoUrl] = useState("");
  const [isAddingVideo, setIsAddingVideo] = useState(false);

  const isComplete = useMemo(() => {
    const hasPdf = resources.length > 0;
    const hasValidVideo = videos.some((v) => Boolean(v.embed_url));
    return hasPdf || hasValidVideo;
  }, [resources, videos]);

  useEffect(() => {
    onCompletionChange(isComplete);
  }, [isComplete, onCompletionChange]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [resA, resB] = await Promise.all([
        fetch(`/api/courses/${courseId}/resources`, { cache: "no-store" }),
        fetch(`/api/courses/${courseId}/videos`, { cache: "no-store" }),
      ]);

      const a = (await resA.json().catch(() => ({}))) as { resources?: ResourceRow[]; error?: string };
      const b = (await resB.json().catch(() => ({}))) as { videos?: VideoRow[]; error?: string };

      if (!resA.ok) throw new Error(a.error || "Failed to load resources");
      if (!resB.ok) throw new Error(b.error || "Failed to load videos");

      setResources(Array.isArray(a.resources) ? a.resources : []);
      setVideos(Array.isArray(b.videos) ? b.videos : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load resources");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  async function uploadPdfs() {
    if (pdfFiles.length === 0) return;
    setIsUploading(true);
    setError(null);
    try {
      const form = new FormData();
      pdfFiles.forEach((f) => form.append("files", f));
      const res = await fetch(`/api/courses/${courseId}/resources`, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || "Failed to upload PDFs");
      setPdfFiles([]);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload PDFs");
    } finally {
      setIsUploading(false);
    }
  }

  async function deleteResource(id: string) {
    setError(null);
    const res = await fetch(`/api/courses/${courseId}/resources/${id}`, { method: "DELETE" });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(body.error || "Failed to delete resource");
      return;
    }
    await load();
  }

  async function addVideo() {
    const url = videoUrl.trim();
    if (!url) return;
    setIsAddingVideo(true);
    setError(null);
    try {
      const res = await fetch(`/api/courses/${courseId}/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || "Failed to add video");
      setVideoUrl("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add video");
    } finally {
      setIsAddingVideo(false);
    }
  }

  async function deleteVideo(id: string) {
    setError(null);
    const res = await fetch(`/api/courses/${courseId}/videos/${id}`, { method: "DELETE" });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(body.error || "Failed to delete video");
      return;
    }
    await load();
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* PDFs */}
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div>
            <div className="text-lg font-semibold text-foreground">Add resources</div>
            <p className="text-sm text-muted-foreground">Upload PDF files (multiple allowed).</p>
          </div>

          <div className="space-y-2">
            <Label>Upload PDFs</Label>
            <Input
              type="file"
              accept="application/pdf,.pdf"
              multiple
              onChange={(e) => setPdfFiles(Array.from(e.target.files ?? []))}
            />
            <Button variant="secondary" onClick={uploadPdfs} disabled={pdfFiles.length === 0 || isUploading}>
              {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload
            </Button>
          </div>

          <div className="border rounded-md overflow-hidden">
            <div className="px-3 py-2 text-xs font-medium bg-muted/40 text-muted-foreground">Uploaded PDFs</div>
            {loading ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">Loading…</div>
            ) : resources.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">No PDFs yet.</div>
            ) : (
              <ul className="divide-y">
                {resources.map((r) => (
                  <li key={r.id} className="px-3 py-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">{r.file_name}</div>
                      <div className="text-xs text-muted-foreground">{formatBytes(r.size_bytes)}</div>
                    </div>
                    <Button variant="ghost" size="icon-sm" onClick={() => void deleteResource(r.id)} aria-label="Delete">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Videos */}
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div>
            <div className="text-lg font-semibold text-foreground">Embedded videos</div>
            <p className="text-sm text-muted-foreground">
              Paste a full YouTube/Vimeo URL. If it’s invalid or private, it will be saved but no preview will show.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="videoUrl">Video URL</Label>
            <Input
              id="videoUrl"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
            />
            <Button onClick={() => void addVideo()} disabled={isAddingVideo || videoUrl.trim().length === 0}>
              {isAddingVideo ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Add video
            </Button>
          </div>

          <div className="space-y-3">
            {loading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : videos.length === 0 ? (
              <div className="text-sm text-muted-foreground">No videos yet.</div>
            ) : (
              videos.map((v) => (
                <div key={v.id} className="rounded-md border bg-background p-3 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">{v.title ?? v.original_url}</div>
                      <div className="text-xs text-muted-foreground truncate">{v.original_url}</div>
                    </div>
                    <Button variant="ghost" size="icon-sm" onClick={() => void deleteVideo(v.id)} aria-label="Delete">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {v.embed_url ? (
                    <div className="relative w-full aspect-video overflow-hidden rounded-md border">
                      <iframe
                        src={v.embed_url}
                        title={v.title ?? "Embedded video"}
                        className="absolute inset-0 h-full w-full"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
                  ) : v.thumbnail_url ? (
                    <div className="relative w-full aspect-video overflow-hidden rounded-md border">
                      <Image
                        src={v.thumbnail_url}
                        alt={v.title ?? "Video thumbnail"}
                        fill
                        className="object-cover"
                        sizes="(max-width: 1024px) 100vw, 520px"
                      />
                      <div className="absolute inset-0 bg-black/25 flex items-center justify-center text-white text-sm font-medium">
                        Preview unavailable (saved)
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                      Preview unavailable (saved). Check the URL or video privacy.
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="rounded-md border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        Step 2 is required before publishing: add at least one PDF resource or one valid video embed.
      </div>
    </div>
  );
}

