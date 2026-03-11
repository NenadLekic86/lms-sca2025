import { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { generateSupportId } from "@/lib/support/supportId";

export const runtime = "nodejs";

const commitSchema = z.object({
  storage_path: z.string().min(1).max(600),
  mime: z.literal("video/mp4"),
  size_bytes: z.number().int().positive().max(300 * 1024 * 1024),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: courseId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = commitSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Invalid request.", { status: 400 });

  const { storage_path, mime, size_bytes } = parsed.data;

  // Defense-in-depth: ensure the committed path matches the course/org prefix we generate.
  const expectedPrefix = `${caller.organization_id}/${courseId}/`;
  if (!storage_path.startsWith(expectedPrefix)) {
    return apiError("VALIDATION_ERROR", "Invalid storage path.", { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data: row, error: rowError } = await admin
    .from("courses")
    .select("id, organization_id, intro_video_storage_path")
    .eq("id", courseId)
    .single();
  if (rowError || !row?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (String(row.organization_id ?? "") !== String(caller.organization_id)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const prevPath = typeof row.intro_video_storage_path === "string" && row.intro_video_storage_path.trim().length ? row.intro_video_storage_path.trim() : null;

  const now = new Date().toISOString();
  const { error: updateError } = await admin
    .from("courses")
    .update({
      intro_video_provider: "html5",
      intro_video_url: null,
      intro_video_storage_path: storage_path,
      intro_video_size_bytes: size_bytes,
      intro_video_mime: mime,
      updated_at: now,
    })
    .eq("id", courseId);

  if (updateError) {
    const supportId = generateSupportId();
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to save intro video.",
      internalMessage: updateError.message,
      details: { course_id: courseId, support_id: supportId },
    });
    return apiError("INTERNAL", "Failed to save intro video.", { status: 500, supportId });
  }

  // Best-effort cleanup (delayed): enqueue previous intro video object.
  if (prevPath && prevPath !== storage_path) {
    const rpc = await admin.rpc("enqueue_asset_deletion", {
      p_bucket_id: "course-intro-videos",
      p_object_name: prevPath,
      p_delay_seconds: 60 * 60 * 2,
      p_requested_by: caller.id,
      p_reason: "replaced intro video",
    });
    if (rpc.error) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Intro video saved, but cleanup enqueue failed.",
        internalMessage: rpc.error.message,
        details: { course_id: courseId, prev_path: prevPath },
      });
      // Continue: we do not fail the user save due to cleanup enqueue.
    }
  }

  return apiOk(
    {
      intro_video: {
        provider: "html5",
        url: null,
        storage_path,
        size_bytes,
        mime,
      },
    },
    { status: 200, message: "Intro video saved." }
  );
}

