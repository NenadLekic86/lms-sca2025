import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

export type ApiSuccess<T> = {
  success: true;
  message?: string;
  data: T;
};

export type ApiFailure = {
  success: false;
  error: {
    code: ApiErrorCode;
    message: string;
  };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function apiOk<T>(data: T, opts?: { status?: number; message?: string }) {
  const status = opts?.status ?? 200;
  const body: ApiSuccess<T> = { success: true, data };
  if (opts?.message) body.message = opts.message;
  return NextResponse.json(body, { status });
}

export function apiError(code: ApiErrorCode, message: string, opts?: { status?: number }) {
  const status = opts?.status ?? 500;
  const body: ApiFailure = { success: false, error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function readJsonBody(request: Request): Promise<unknown | null> {
  return request.json().catch(() => null);
}

