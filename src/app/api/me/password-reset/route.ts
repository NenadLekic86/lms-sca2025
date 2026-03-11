import { NextRequest } from "next/server";
import { env } from "@/env.mjs";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

/**
 * POST /api/me/password-reset
 * Sends the authenticated user a Supabase password recovery email.
 */
export async function POST(request: NextRequest) {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({
      request,
      caller: null,
      outcome: "error",
      status: 401,
      code: "UNAUTHORIZED",
      publicMessage: "Unauthorized",
      internalMessage: typeof error === "string" ? error : "No authenticated user",
    });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

  const admin = createAdminSupabaseClient();
  const { error: sendError } = await admin.auth.resetPasswordForEmail(caller.email, {
    redirectTo: `${appUrl}/reset-password`,
  });

  if (sendError) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to send reset password link.",
      internalMessage: sendError.message,
    });
    return apiError("INTERNAL", "Failed to send reset password link.", { status: 500 });
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Reset password link sent.",
  });

  return apiOk({ ok: true }, { status: 200, message: "Reset password link sent." });
}

