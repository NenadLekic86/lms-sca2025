import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { generateSupportId } from "@/lib/support/supportId";

export const runtime = "nodejs";

const reportSchema = z.object({
  support_id: z.string().min(3).max(40).optional(),
  source: z.string().min(1).max(80).optional(),
  step: z.string().max(200).optional().nullable(),
  page_url: z.string().max(2000).optional().nullable(),
  user_agent: z.string().max(800).optional().nullable(),
  payload: z.unknown().optional(),
});

export async function POST(request: NextRequest) {
  const { user: caller, error: authError } = await getServerUser();
  if (authError || !caller) {
    await logApiEvent({
      request,
      caller: null,
      outcome: "error",
      status: 401,
      code: "UNAUTHORIZED",
      publicMessage: "Unauthorized",
      internalMessage: typeof authError === "string" ? authError : "No authenticated user",
    });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 400,
      code: "VALIDATION_ERROR",
      publicMessage: "Invalid error report payload.",
    });
    return apiError("VALIDATION_ERROR", "Invalid request.", { status: 400 });
  }

  const supportId = parsed.data.support_id ?? generateSupportId();
  const source = parsed.data.source ?? "course_builder";
  const step = parsed.data.step ?? null;
  const pageUrl = parsed.data.page_url ?? null;
  const userAgent = parsed.data.user_agent ?? request.headers.get("user-agent") ?? null;
  const payload = parsed.data.payload ?? {};

  const admin = createAdminSupabaseClient();
  const { data: inserted, error: insertError } = await admin
    .from("support_reports")
    .insert({
      support_id: supportId,
      source,
      step,
      reporter_user_id: caller.id,
      reporter_email: caller.email,
      reporter_role: caller.role,
      organization_id: caller.organization_id ?? null,
      page_url: pageUrl,
      user_agent: userAgent,
      payload,
    })
    .select("id")
    .single();

  if (insertError || !inserted?.id) {
    const internalSupportId = generateSupportId();
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to submit error report.",
      internalMessage: insertError?.message,
      details: { support_id: internalSupportId },
    });
    return apiError("INTERNAL", "Failed to submit error report.", { status: 500, supportId: internalSupportId });
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Error report submitted.",
    details: { support_report_id: inserted.id, support_id: supportId },
  });

  return apiOk({ support_report_id: inserted.id, support_id: supportId }, { status: 200, message: "Report submitted." });
}

