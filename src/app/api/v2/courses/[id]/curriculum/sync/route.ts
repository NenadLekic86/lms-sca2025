import { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { generateSupportId } from "@/lib/support/supportId";

export const runtime = "nodejs";

const curriculumSchema = z.object({
  topics: z
    .array(
      z.object({
        client_id: z.string().min(1).max(200),
        // The DB RPC expects `id` to be present for BOTH:
        // - existing topics (UUID)
        // - new topics created client-side ("tmp_...")
        id: z.string().min(1).max(200),
        title: z.string().trim().min(2),
        summary: z.string().nullable().optional(),
        position: z.number().int().nonnegative().optional(),
        items: z
          .array(
            z.object({
              client_id: z.string().min(1).max(200),
              id: z.string().min(1).max(200),
              item_type: z.enum(["lesson", "quiz"]),
              title: z.string().trim().min(2),
              is_required: z.boolean().optional(),
              position: z.number().int().nonnegative().optional(),
            })
          )
          .optional(),
      })
    )
    .max(1000),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: courseId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = curriculumSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Invalid request.", { status: 400 });

  try {
    // IMPORTANT: use service role to bypass RLS; RPC itself validates actor/org/course ownership.
    const admin = createAdminSupabaseClient();
    const { data, error: rpcError } = await admin.rpc("v2_sync_course_curriculum_struct", {
      p_actor_id: caller.id,
      p_org_id: caller.organization_id,
      p_course_id: courseId,
      p_payload: parsed.data,
    });

    if (rpcError) {
      const supportId = generateSupportId();
      const rpcDebug = {
        message: rpcError.message,
        code: (rpcError as { code?: unknown }).code ?? null,
        details: (rpcError as { details?: unknown }).details ?? null,
        hint: (rpcError as { hint?: unknown }).hint ?? null,
      };
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: (rpcDebug.code === "P0001" ? 400 : 500),
        code: (rpcDebug.code === "P0001" ? "VALIDATION_ERROR" : "INTERNAL"),
        publicMessage: (rpcDebug.code === "P0001" ? "Invalid curriculum payload." : "Failed to sync curriculum."),
        internalMessage: rpcError.message,
        details: {
          course_id: courseId,
          support_id: supportId,
          rpc: rpcDebug,
        },
      });

      // In dev, include safe debug so System Reports capture the real root cause.
      if (process.env.NODE_ENV !== "production") {
        return NextResponse.json(
          {
            success: false,
            support_id: supportId,
            error: { code: (rpcDebug.code === "P0001" ? "VALIDATION_ERROR" : "INTERNAL"), message: rpcError.message },
            debug: { rpc: rpcDebug },
          },
          { status: (rpcDebug.code === "P0001" ? 400 : 500) }
        );
      }

      if (rpcDebug.code === "P0001") {
        return apiError("VALIDATION_ERROR", "Invalid curriculum payload.", { status: 400 });
      }
      return apiError("INTERNAL", "Failed to sync curriculum.", { status: 500, supportId });
    }

    return apiOk({ ...(typeof data === "object" && data ? (data as Record<string, unknown>) : {}) }, { status: 200 });
  } catch (e) {
    const supportId = generateSupportId();
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to sync curriculum.",
      internalMessage: e instanceof Error ? e.message : String(e ?? ""),
      details: { course_id: courseId, support_id: supportId },
    });
    return apiError("INTERNAL", "Failed to sync curriculum.", { status: 500, supportId });
  }
}

