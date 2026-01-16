import { NextResponse } from "next/server";
import { appendErrorLog, isLocalErrorLoggingEnabled } from "@/lib/logging/errorLogger";

export async function POST(req: Request) {
  if (!isLocalErrorLoggingEnabled()) {
    return NextResponse.json({ ok: true });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  await appendErrorLog({
    source: "client",
    ...((body && typeof body === "object") ? body : { message: "Invalid client error payload" }),
  });

  return NextResponse.json({ ok: true });
}
