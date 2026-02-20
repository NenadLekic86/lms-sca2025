"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CertificateNamePlacement = {
  page: number; // 1-based
  xPct: number; // from left, 0..1
  yPct: number; // from top, 0..1
  wPct?: number; // 0..1 (optional)
  hPct?: number; // 0..1 (optional)
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
};

export function CertificatePlacementModal({
  open,
  templateMime,
  templateDownloadUrl,
  initialPlacement,
  onClose,
  onSave,
}: {
  open: boolean;
  templateMime: string;
  templateDownloadUrl: string;
  initialPlacement: CertificateNamePlacement | null;
  onClose: () => void;
  onSave: (placement: CertificateNamePlacement) => void;
}) {
  const isPdf = templateMime === "application/pdf";
  const isImage = templateMime.startsWith("image/");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const pdfjsRef = useRef<unknown>(null);

  const [pageCount, setPageCount] = useState<number>(1);
  const [page, setPage] = useState<number>(initialPlacement?.page ?? 1);

  // Placement box (stored in % relative to current page viewport)
  const [placement, setPlacement] = useState<CertificateNamePlacement>(() => {
    return (
      initialPlacement ?? {
        page: 1,
        xPct: 0.5,
        yPct: 0.7,
        wPct: 0.42,
        hPct: 0.08,
        fontSize: 32,
        color: "#111111",
        align: "center",
      }
    );
  });

  // Keep placement.page in sync with current page state
  useEffect(() => {
    if (!open) return;
    setPlacement((p) => ({ ...p, page }));
  }, [page, open]);

  // Load bytes when opened
  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    setBytes(null);
    setImgUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(templateDownloadUrl, { method: "GET" });
        if (!res.ok) throw new Error(`Failed to load template (${res.status})`);
        const ab = await res.arrayBuffer();
        if (cancelled) return;
        setBytes(ab);
        if (isImage) {
          const blob = new Blob([ab], { type: templateMime });
          setImgUrl(URL.createObjectURL(blob));
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load template");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templateDownloadUrl]);

  // Render PDF page into canvas
  useEffect(() => {
    if (!open) return;
    if (!isPdf) return;
    if (!bytes) return;
    if (typeof window === "undefined") return;

    let destroyed = false;
    (async () => {
      try {
        // Lazy-load pdfjs only in browser to avoid DOMMatrix issues on the server.
        const g = globalThis as unknown as { __pdfjsWorkerConfigured?: boolean };
        const loaded = pdfjsRef.current
          ? pdfjsRef.current
          : await import("pdfjs-dist/legacy/build/pdf.mjs").then((m) => {
              pdfjsRef.current = m;
              return m as unknown;
            });

        const pdfjs = loaded as unknown as {
          GlobalWorkerOptions: { workerSrc: string };
          getDocument: (opts: { data: ArrayBuffer }) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<unknown> }> };
        };

        if (!g.__pdfjsWorkerConfigured) {
          try {
            pdfjs.GlobalWorkerOptions.workerSrc = new URL(
              "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
              import.meta.url
            ).toString();
            g.__pdfjsWorkerConfigured = true;
          } catch {
            // ignore (best-effort)
          }
        }

        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        if (destroyed) return;
        setPageCount(doc.numPages || 1);

        const safePage = Math.max(1, Math.min(page, doc.numPages || 1));
        if (safePage !== page) setPage(safePage);

        const pUnknown = await doc.getPage(safePage);
        const p = pUnknown as unknown as {
          getViewport: (args: { scale: number }) => { width: number; height: number };
          render: (args: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<unknown> };
        };
        if (destroyed) return;

        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const viewport0 = p.getViewport({ scale: 1 });
        const maxW = Math.max(320, Math.floor(container.clientWidth));
        const scale = maxW / viewport0.width;
        const viewport = p.getViewport({ scale });

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        await p.render({ canvasContext: ctx, viewport }).promise;
      } catch (e) {
        if (!destroyed) setError(e instanceof Error ? e.message : "Failed to render PDF");
      }
    })();

    return () => {
      destroyed = true;
    };
  }, [open, isPdf, bytes, page]);

  const viewportSize = (() => {
    const canvas = canvasRef.current;
    if (isPdf && canvas) return { w: canvas.width, h: canvas.height };
    const container = containerRef.current;
    if (isImage && container) return { w: container.clientWidth, h: container.clientHeight };
    return { w: 0, h: 0 };
  })();

  const boxPx = useMemo(() => {
    const w = Math.max(0, viewportSize.w);
    const h = Math.max(0, viewportSize.h);
    const wPct = placement.wPct ?? 0.42;
    const hPct = placement.hPct ?? 0.08;
    return {
      x: Math.round(placement.xPct * w),
      y: Math.round(placement.yPct * h),
      w: Math.round(wPct * w),
      h: Math.round(hPct * h),
    };
  }, [placement, viewportSize]);

  function clamp01(n: number) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function applyDrag(dx: number, dy: number) {
    const w = viewportSize.w || 1;
    const h = viewportSize.h || 1;
    setPlacement((prev) => ({
      ...prev,
      xPct: clamp01((prev.xPct * w + dx) / w),
      yPct: clamp01((prev.yPct * h + dy) / h),
    }));
  }

  const dragRef = useRef<{ active: boolean; lastX: number; lastY: number }>({ active: false, lastX: 0, lastY: 0 });

  function onBoxMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
  }

  useEffect(() => {
    if (!open) return;
    function onMove(e: MouseEvent) {
      if (!dragRef.current.active) return;
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      applyDrag(dx, dy);
    }
    function onUp() {
      dragRef.current.active = false;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, viewportSize.w, viewportSize.h]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-100000 bg-black/50 p-3 sm:p-6" role="dialog" aria-modal="true">
      <div className="mx-auto h-[calc(100svh-24px)] sm:h-[calc(100svh-48px)] max-w-[1100px]">
        <div className="h-full rounded-2xl border bg-white shadow-2xl overflow-hidden flex flex-col">
          <div
            style={{
              background: "linear-gradient(135deg, #0e4d2c 0%, #1b6b3a 50%, #2d8f52 100%)",
              color: "#fff",
              padding: "14px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
            }}
          >
            <div style={{ fontWeight: 800, fontSize: "14px" }}>🏆 Place member name</div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg"
              style={{ background: "rgba(255,255,255,0.16)", border: "1px solid rgba(255,255,255,0.25)" }}
              aria-label="Close"
              title="Close"
            >
              <X className="h-4 w-4 text-white" />
            </button>
          </div>

          <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-[1fr_320px]">
            {/* Preview */}
            <div className="relative overflow-auto bg-linear-to-br from-slate-50 to-white p-4">
              <div className="mx-auto w-full max-w-[860px]">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-xs text-muted-foreground">
                    Drag the highlighted box to choose where the learner’s <span className="font-semibold text-foreground">Full name</span> will be printed.
                  </div>
                  {isPdf ? (
                    <div className="flex items-center gap-2">
                      <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <div className="text-xs text-muted-foreground">
                        Page <span className="font-semibold text-foreground">{page}</span> / {pageCount}
                      </div>
                      <Button type="button" size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : null}
                </div>

                <div
                  ref={containerRef}
                  className="relative mx-auto rounded-xl border bg-white shadow-sm overflow-hidden"
                  style={{ maxWidth: "860px" }}
                >
                  {loading ? (
                    <div className="p-10 text-sm text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading template…
                    </div>
                  ) : error ? (
                    <div className="p-10 text-sm text-destructive">{error}</div>
                  ) : isPdf ? (
                    <canvas ref={canvasRef} style={{ width: "100%", height: "auto", display: "block" }} />
                  ) : isImage && imgUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="Certificate template preview" src={imgUrl} style={{ width: "100%", height: "auto", display: "block" }} />
                  ) : (
                    <div className="p-10 text-sm text-muted-foreground">Unsupported template type.</div>
                  )}

                  {/* Placement box */}
                  {!loading && !error ? (
                    <div
                      role="button"
                      tabIndex={0}
                      onMouseDown={onBoxMouseDown}
                      className={cn("absolute select-none")}
                      style={{
                        left: `${Math.max(0, boxPx.x - Math.round(boxPx.w / 2))}px`,
                        top: `${Math.max(0, boxPx.y - Math.round(boxPx.h / 2))}px`,
                        width: `${Math.max(60, boxPx.w)}px`,
                        height: `${Math.max(26, boxPx.h)}px`,
                        borderRadius: "10px",
                        border: "2px dashed rgba(27,107,184,0.65)",
                        background: "linear-gradient(135deg, rgba(27,107,184,0.12) 0%, rgba(124,58,189,0.07) 100%)",
                        boxShadow: "0 6px 20px rgba(27,107,184,0.18)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "move",
                        padding: "6px 10px",
                      }}
                      title="Drag to position"
                    >
                      <span style={{ fontWeight: 800, color: "#1b6bb8", fontSize: "13px", textAlign: "center" }}>Full name</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Sidebar */}
            <div className="border-l bg-white p-4 space-y-4 overflow-auto">
              <div className="rounded-xl border p-4">
                <div className="text-sm font-semibold text-foreground">Placement</div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Current: page {placement.page}, x {Math.round(placement.xPct * 100)}%, y {Math.round(placement.yPct * 100)}%
                </div>
              </div>

              <div className="rounded-xl border p-4 space-y-2">
                <div className="text-sm font-semibold text-foreground">Preview text</div>
                <div className="rounded-lg border bg-muted/20 px-3 py-2 text-sm font-semibold">John Doe</div>
                <div className="text-xs text-muted-foreground">We’ll replace this with the learner’s full name when generating certificates.</div>
              </div>

              <div className="pt-2 flex items-center justify-between gap-2">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    onSave({
                      page,
                      xPct: Math.max(0, Math.min(1, placement.xPct)),
                      yPct: Math.max(0, Math.min(1, placement.yPct)),
                      wPct: placement.wPct ?? 0.42,
                      hPct: placement.hPct ?? 0.08,
                      fontSize: placement.fontSize ?? 32,
                      color: placement.color ?? "#111111",
                      align: placement.align ?? "center",
                    });
                  }}
                  className="gap-2"
                >
                  <Check className="h-4 w-4" />
                  Save placement
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

