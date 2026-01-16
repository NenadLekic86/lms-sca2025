'use client';

import { useEffect } from "react";

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    const payload = {
      type: "global-error",
      message: error.message,
      stack: error.stack,
      digest: error.digest,
      href: typeof window !== "undefined" ? window.location.href : undefined,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    };

    fetch("/api/log-client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => undefined);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            An unexpected error occurred. Try reloading the page or returning to the dashboard.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => reset()}
              className="rounded-md bg-primary px-4 py-2 text-white hover:bg-primary/90 transition-colors"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.assign("/")}
              className="rounded-md border px-4 py-2 text-foreground hover:bg-muted/40 transition-colors"
            >
              Go to login
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
