export type InlineImageQueued = { file: File; objectUrl: string };
export type InlineImageQueue = Record<string, InlineImageQueued>;

export type UploadInlineImageFn = (args: { uploadId: string; file: File }) => Promise<{ storage_path: string }>;
export type StableSrcForStoragePathFn = (storagePath: string) => string;

function canUseDomParser(): boolean {
  // DOMParser exists in the browser. This module is intended for client-side use.
  // We guard so accidental server execution fails safely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (globalThis as any).DOMParser !== "undefined";
}

function parseHtml(html: string): Document | null {
  if (!canUseDomParser()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const DOMParserCtor = (globalThis as any).DOMParser as typeof DOMParser;
    return new DOMParserCtor().parseFromString(html, "text/html");
  } catch {
    return null;
  }
}

export function extractInlineUploadIdsFromHtml(html: string): Set<string> {
  const out = new Set<string>();
  const doc = parseHtml(html);
  if (!doc) return out;
  const imgs = Array.from(doc.querySelectorAll("img[data-inline-upload-id]"));
  for (const img of imgs) {
    const id = img.getAttribute("data-inline-upload-id") ?? "";
    if (id) out.add(id);
  }
  return out;
}

export function revokeObjectUrlSafe(objectUrl: string | null | undefined) {
  if (!objectUrl) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const URLCtor = (globalThis as any).URL as typeof URL | undefined;
    if (!URLCtor?.revokeObjectURL) return;
    URLCtor.revokeObjectURL(objectUrl);
  } catch {
    // ignore
  }
}

export function revokeInlineQueueObjectUrls(queue: InlineImageQueue) {
  for (const v of Object.values(queue ?? {})) revokeObjectUrlSafe(v?.objectUrl);
}

export function mergeQueues(a: InlineImageQueue, b: InlineImageQueue): InlineImageQueue {
  return { ...(a ?? {}), ...(b ?? {}) };
}

export function pruneQueueByHtml(queue: InlineImageQueue, html: string): InlineImageQueue {
  const keep = extractInlineUploadIdsFromHtml(html);
  if (!Object.keys(queue ?? {}).length) return {};
  if (!keep.size) return queue;

  const next: InlineImageQueue = {};
  for (const [id, v] of Object.entries(queue)) {
    if (keep.has(id)) next[id] = v;
    else revokeObjectUrlSafe(v?.objectUrl);
  }
  return next;
}

export async function finalizeInlineImagesInHtml(args: {
  html: string;
  queue: InlineImageQueue;
  upload: UploadInlineImageFn;
  stableSrcForStoragePath: StableSrcForStoragePathFn;
}): Promise<{ html: string; uploadedIds: Set<string> }> {
  const { html, queue, upload, stableSrcForStoragePath } = args;
  const uploadedIds = new Set<string>();
  if (!html || !html.trim()) return { html, uploadedIds };
  if (!Object.keys(queue ?? {}).length) return { html, uploadedIds };

  const doc = parseHtml(html);
  if (!doc) return { html, uploadedIds };

  const imgs = Array.from(doc.querySelectorAll("img[data-inline-upload-id]"));
  for (const img of imgs) {
    const uploadId = img.getAttribute("data-inline-upload-id") ?? "";
    if (!uploadId) continue;
    const pending = queue[uploadId] ?? null;
    if (!pending?.file) continue;

    const res = await upload({ uploadId, file: pending.file });
    const storagePath = (res?.storage_path ?? "").toString();
    if (!storagePath) continue;

    img.setAttribute("src", stableSrcForStoragePath(storagePath));
    img.removeAttribute("data-inline-upload-id");
    revokeObjectUrlSafe(pending.objectUrl);
    uploadedIds.add(uploadId);
  }

  return { html: doc.body.innerHTML, uploadedIds };
}

