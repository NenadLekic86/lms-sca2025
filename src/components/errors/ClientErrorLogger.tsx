'use client';

import { useEffect } from "react";

type ErrorPayload = Record<string, unknown>;

function toSafeString(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function sendClientError(payload: ErrorPayload) {
  try {
    await fetch("/api/log-client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Ignore logging failures to avoid recursive errors.
  }
}

export function ClientErrorLogger() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      void sendClientError({
        type: "error",
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack,
        href: window.location.href,
        userAgent: navigator.userAgent,
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      void sendClientError({
        type: "unhandledrejection",
        reason: toSafeString(event.reason),
        stack: event.reason instanceof Error ? event.reason.stack : undefined,
        href: window.location.href,
        userAgent: navigator.userAgent,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
