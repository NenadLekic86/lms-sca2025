import { appendErrorLog, isLocalErrorLoggingEnabled } from "@/lib/logging/errorLogger";

declare global {
  var __isoServerErrorBootstrap: boolean | undefined;
}

export function initServerErrorLogging() {
  if (!isLocalErrorLoggingEnabled()) return;
  if (typeof process === "undefined" || typeof process.on !== "function") return;
  if (globalThis.__isoServerErrorBootstrap) return;
  globalThis.__isoServerErrorBootstrap = true;

  process.on("uncaughtException", (err) => {
    void appendErrorLog({
      source: "server",
      type: "uncaughtException",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });

  process.on("unhandledRejection", (reason) => {
    void appendErrorLog({
      source: "server",
      type: "unhandledRejection",
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
