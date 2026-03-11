import type { ApiFailure, ApiResponse, ApiSuccess } from "@/lib/api/response";

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly supportId?: string;
  readonly raw?: unknown;

  constructor(message: string, opts: { status: number; code?: string; supportId?: string; raw?: unknown }) {
    super(message);
    this.name = "ApiClientError";
    this.status = opts.status;
    this.code = opts.code;
    this.supportId = opts.supportId;
    this.raw = opts.raw;
  }
}

function isApiSuccess<T>(body: unknown): body is ApiSuccess<T> {
  return !!body && typeof body === "object" && (body as { success?: unknown }).success === true && "data" in (body as object);
}

function isApiFailure(body: unknown): body is ApiFailure {
  return (
    !!body &&
    typeof body === "object" &&
    (body as { success?: unknown }).success === false &&
    !!(body as { error?: unknown }).error &&
    typeof (body as { error: { message?: unknown } }).error.message === "string"
  );
}

/**
 * Fetch JSON with support for BOTH:
 * - New envelope: { success: true, data, message? } / { success: false, error: { code, message } }
 * - Legacy endpoints: { ... } on success, { error: string } on failure
 */
export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{ data: T; message?: string; raw: unknown }> {
  const res = await fetch(input, init);
  const clone = res.clone();
  const rawJson = (await res.json().catch(() => null)) as unknown;
  const rawText = rawJson === null ? await clone.text().catch(() => null) : null;
  const raw = rawJson ?? (typeof rawText === "string" && rawText.length ? { text: rawText.slice(0, 2000) } : null);

  // New envelope
  if (isApiSuccess<T>(raw)) {
    return { data: raw.data, message: raw.message, raw };
  }
  if (isApiFailure(raw)) {
    const supportId = typeof (raw as { support_id?: unknown }).support_id === "string" ? (raw as { support_id: string }).support_id : undefined;
    throw new ApiClientError(raw.error.message, { status: res.status, code: raw.error.code, supportId, raw });
  }

  // Legacy success
  if (res.ok) {
    const msg = (raw && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string")
      ? ((raw as { message: string }).message)
      : undefined;
    return { data: raw as T, message: msg, raw };
  }

  // Legacy error
  const legacyError =
    raw && typeof raw === "object" && typeof (raw as { error?: unknown }).error === "string"
      ? (raw as { error: string }).error
      : null;

  const fallback =
    legacyError ||
    (typeof rawText === "string" && rawText.trim().length > 0
      ? `Request failed (HTTP ${res.status})`
      : `Request failed (HTTP ${res.status})`);

  throw new ApiClientError(fallback, { status: res.status, raw });
}

export type { ApiResponse };

