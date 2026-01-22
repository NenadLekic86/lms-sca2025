import { NextRequest } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string; resourceId: string }> }) {
  const { id, resourceId } = await context.params;
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

  // Use session client to ensure the caller can RLS-read this resource row.
  // Members will only see resources for courses they are actively enrolled in.
  const supabase = await createServerSupabaseClient();
  const { data: resourceRow, error: loadError } = await supabase
    .from("course_resources")
    .select("id, course_id, storage_bucket, storage_path, file_name, mime_type")
    .eq("id", resourceId)
    .eq("course_id", id)
    .single();

  if (loadError || !resourceRow) {
    return apiError("NOT_FOUND", "Resource not found.", { status: 404 });
  }

  // Signed URLs are generated with service role. Access is already enforced above via RLS read.
  const admin = createAdminSupabaseClient();
  const { data: signed, error: signedError } = await admin.storage
    .from(resourceRow.storage_bucket)
    .createSignedUrl(resourceRow.storage_path, 60 * 10);

  if (signedError || !signed?.signedUrl) {
    return apiError("INTERNAL", "Failed to create signed URL.", { status: 500 });
  }

  return apiOk(
    {
      signedUrl: signed.signedUrl,
      file_name: resourceRow.file_name,
      mime_type: resourceRow.mime_type,
    },
    { status: 200 }
  );
}

