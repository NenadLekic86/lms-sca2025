import "server-only";

import { createAdminSupabaseClient } from "@/lib/supabase/server";
import type { ApiErrorCode } from "@/lib/api/response";

type Caller = {
  id: string;
  email: string;
  role: string;
  organization_id?: string | null;
};

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - 1)) + "…";
}

function getClientIp(request: Request): string | null {
  const h = request.headers;
  const xff = h.get("x-forwarded-for");
  if (xff && xff.trim().length > 0) return xff.split(",")[0]?.trim() || null;
  const real = h.get("x-real-ip");
  if (real && real.trim().length > 0) return real.trim();
  return null;
}

export async function logApiEvent(input: {
  request: Request;
  caller: Caller | null;
  outcome: "success" | "error";
  status: number;
  publicMessage: string;
  code?: ApiErrorCode | string;
  internalMessage?: string;
  details?: Record<string, unknown>;
}) {
  // Never block API success on audit failures.
  try {
    const admin = createAdminSupabaseClient();
    const url = new URL(input.request.url);
    const method = (input.request.method || "GET").toUpperCase();

    const internal =
      typeof input.internalMessage === "string" && input.internalMessage.trim().length
        ? truncate(input.internalMessage.trim(), 4000)
        : null;

    // If we can't attribute the event to an authenticated caller, store it separately.
    if (!input.caller?.id) {
      await admin.from("unauth_api_events").insert({
        outcome: input.outcome,
        status: input.status,
        method,
        path: url.pathname,
        query: url.search || "",
        ip: getClientIp(input.request),
        user_agent: input.request.headers.get("user-agent"),
        code: input.code ?? null,
        public_message: truncate(input.publicMessage, 500),
        internal_message: internal,
        details: input.details ?? null,
      });
      return;
    }

    const action = input.outcome === "success" ? "api_success" : "api_error";

    await admin.from("audit_logs").insert({
      actor_user_id: input.caller.id,
      actor_email: input.caller.email,
      actor_role: input.caller.role,
      action,
      entity: "api",
      entity_id: url.pathname,
      target_user_id: null,
      metadata: {
        api: {
          method,
          path: url.pathname,
          query: url.search || "",
          status: input.status,
          code: input.code ?? null,
          public_message: truncate(input.publicMessage, 500),
          internal_message: internal,
        },
        details: input.details ?? null,
      },
    });
  } catch {
    // ignore
  }
}

