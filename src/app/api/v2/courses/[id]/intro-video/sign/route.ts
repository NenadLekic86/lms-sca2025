import { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { generateSupportId } from "@/lib/support/supportId";

export const runtime = "nodejs";

const signSchema = z.object({
  mime: z.literal("video/mp4"),
  size_bytes: z.number().int().positive().max(300 * 1024 * 1024),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: courseId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = signSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Invalid request.", { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: row, error: rowError } = await admin
    .from("courses")
    .select("id, organization_id")
    .eq("id", courseId)
    .single();
  if (rowError || !row?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (String(row.organization_id ?? "") !== String(caller.organization_id)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const ts = Date.now();
  const object_name = `${caller.organization_id}/${courseId}/intro-${ts}.mp4`;

  const { data: signed, error: signedError } = await admin.storage.from("course-intro-videos").createSignedUploadUrl(object_name);
  if (signedError || !signed?.token) {
    const supportId = generateSupportId();
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to create signed upload URL.",
      internalMessage: signedError?.message,
      details: { course_id: courseId, support_id: supportId },
    });
    return apiError("INTERNAL", "Failed to create signed upload URL.", { status: 500, supportId });
  }

  return apiOk(
    {
      bucket_id: "course-intro-videos",
      object_name,
      token: signed.token,
    },
    { status: 200 }
  );
}

