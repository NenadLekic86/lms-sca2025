import type { ApiFailure, ApiResponse, ApiSuccess } from "@/lib/api/response";

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, opts: { status: number; code?: string }) {
    super(message);
    this.name = "ApiClientError";
    this.status = opts.status;
    this.code = opts.code;
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
  const raw = (await res.json().catch(() => null)) as unknown;

  // New envelope
  if (isApiSuccess<T>(raw)) {
    return { data: raw.data, message: raw.message, raw };
  }
  if (isApiFailure(raw)) {
    throw new ApiClientError(raw.error.message, { status: res.status, code: raw.error.code });
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

  throw new ApiClientError(legacyError || "Request failed", { status: res.status });
}

export type { ApiResponse };

