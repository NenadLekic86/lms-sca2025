import { promises as fs } from "fs";
import path from "path";

export type ErrorLogEntry = Record<string, unknown>;

export function isLocalErrorLoggingEnabled() {
  return process.env.NODE_ENV !== "production";
}

export async function appendErrorLog(entry: ErrorLogEntry) {
  if (!isLocalErrorLoggingEnabled()) return;

  try {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    });
    const logPath = path.join(process.cwd(), "error.log");
    await fs.appendFile(logPath, `${line}\n`, "utf8");
  } catch {
    // Avoid throwing in logging itself.
  }
}
