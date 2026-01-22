import { appendErrorLog, isLocalErrorLoggingEnabled } from "@/lib/logging/errorLogger";
import { apiOk } from "@/lib/api/response";

export async function POST(req: Request) {
  if (!isLocalErrorLoggingEnabled()) {
    return apiOk({ ok: true }, { status: 200 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  await appendErrorLog({
    source: "client",
    ...((body && typeof body === "object") ? body : { message: "Invalid client error payload" }),
  });

  return apiOk({ ok: true }, { status: 200 });
}
