import { createAdminSupabaseClient, getServerUser } from '@/lib/supabase/server';
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = 'nodejs';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB (matches your bucket limit)
const ALLOWED_MIME = new Set(['image/png', 'image/webp', 'image/svg+xml']);

function getExt(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'bin';
  }
}

export async function POST(request: Request) {
  // super_admin only
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
  if (caller.role !== 'super_admin') {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: "Invalid form data." });
    return apiError("VALIDATION_ERROR", "Invalid form data.", { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: "Missing file." });
    return apiError("VALIDATION_ERROR", "Missing file.", { status: 400 });
  }

  if (!ALLOWED_MIME.has(file.type)) {
    const msg = `Invalid file type. Allowed: ${Array.from(ALLOWED_MIME).join(", ")}`;
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: msg });
    return apiError("VALIDATION_ERROR", msg, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: "File too large (max 2MB)." });
    return apiError("VALIDATION_ERROR", "File too large (max 2MB).", { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Versioned file name to avoid caching issues
  const ext = getExt(file.type);
  const ts = Date.now();
  const objectPath = `logos/app-logo-${ts}.${ext}`;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: uploadError } = await admin.storage
    .from('branding')
    .upload(objectPath, bytes, {
      contentType: file.type,
      upsert: true,
      cacheControl: '3600',
    });

  if (uploadError) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Upload failed.",
      internalMessage: uploadError.message,
    });
    return apiError("INTERNAL", "Upload failed.", { status: 500 });
  }

  const { data: publicUrlData } = admin.storage.from('branding').getPublicUrl(objectPath);
  const publicUrl = publicUrlData.publicUrl;

  // Update the single settings row
  const { data: current, error: currentError } = await admin
    .from('public_app_settings')
    .select('id')
    .single();

  if (currentError || !current?.id) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Settings row not found.",
      internalMessage: currentError?.message || "public_app_settings row missing",
    });
    return apiError("INTERNAL", "Settings row not found.", { status: 500 });
  }

  const { data: updated, error: updateError } = await admin
    .from('public_app_settings')
    .update({
      logo_url: publicUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', current.id)
    .select('id, logo_url')
    .single();

  if (updateError || !updated) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to update settings.",
      internalMessage: updateError?.message || "no updated row returned",
    });
    return apiError("INTERNAL", "Failed to update settings.", { status: 500 });
  }

  // Best-effort audit log
  try {
    await admin.from('audit_logs').insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: 'upload_branding_logo',
      entity: 'storage.branding',
      entity_id: current.id,
      metadata: {
        bucket: 'branding',
        path: objectPath,
        logo_url: publicUrl,
        mime: file.type,
        size: file.size,
      },
    });
  } catch {
    // don't block success
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 201,
    publicMessage: "Logo uploaded.",
    details: { logo_url: updated.logo_url, path: objectPath, mime: file.type, size: file.size },
  });

  return apiOk(
    {
      logo_url: updated.logo_url,
      path: objectPath,
    },
    { status: 201, message: "Logo uploaded." }
  );
}


