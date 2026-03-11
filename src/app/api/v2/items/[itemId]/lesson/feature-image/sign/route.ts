import { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { generateSupportId } from "@/lib/support/supportId";

export const runtime = "nodejs";

function getExtFromMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "bin";
}

const signSchema = z.object({
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  size_bytes: z.number().int().positive().max(10 * 1024 * 1024),
});

export async function POST(request: NextRequest, context: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = signSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Invalid request.", { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: item, error: itemError } = await admin
    .from("course_topic_items")
    .select("id, organization_id, course_id")
    .eq("id", itemId)
    .single();
  if (itemError || !item?.id) return apiError("NOT_FOUND", "Item not found.", { status: 404 });
  if (String(item.organization_id ?? "") !== String(caller.organization_id)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const ext = getExtFromMime(parsed.data.mime);
  const ts = Date.now();
  const object_name = `${caller.organization_id}/${item.course_id}/${itemId}/feature-${ts}.${ext}`;

  const { data: signed, error: signedError } = await admin.storage.from("course-lesson-assets").createSignedUploadUrl(object_name);
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
      details: { item_id: itemId, course_id: item.course_id, support_id: supportId },
    });
    return apiError("INTERNAL", "Failed to create signed upload URL.", { status: 500, supportId });
  }

  return apiOk(
    {
      bucket_id: "course-lesson-assets",
      object_name,
      token: signed.token,
    },
    { status: 200 }
  );
}

