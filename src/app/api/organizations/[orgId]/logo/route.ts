import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB (matches bucket limit)
const ALLOWED_MIME = new Set(["image/png", "image/webp", "image/svg+xml"]);

function getExt(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

function canManageOrgLogo(caller: { role: string; organization_id: string | null }, orgId: string): boolean {
  if (caller.role === "super_admin" || caller.role === "system_admin") return true;
  if (caller.role === "organization_admin" && caller.organization_id === orgId) return true;
  return false;
}

export async function POST(request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;

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
  if (!canManageOrgLogo(caller, orgId)) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return apiError("VALIDATION_ERROR", "Invalid form data.", { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File)) {
    return apiError("VALIDATION_ERROR", "Missing file.", { status: 400 });
  }

  if (!ALLOWED_MIME.has(file.type)) {
    return apiError("VALIDATION_ERROR", `Invalid file type. Allowed: ${Array.from(ALLOWED_MIME).join(", ")}`, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    return apiError("VALIDATION_ERROR", "File too large (max 2MB).", { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Ensure org exists (and provides better error than silent update miss)
  const { data: org, error: orgError } = await admin.from("organizations").select("id").eq("id", orgId).single();
  if (orgError || !org?.id) {
    return apiError("NOT_FOUND", "Organization not found.", { status: 404 });
  }

  // Versioned file name to avoid caching issues
  const ext = getExt(file.type);
  const ts = Date.now();
  const objectPath = `orgs/${orgId}/logo-${ts}.${ext}`;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: uploadError } = await admin.storage.from("org-logos").upload(objectPath, bytes, {
    contentType: file.type,
    upsert: true,
    cacheControl: "3600",
  });

  if (uploadError) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Upload failed.", internalMessage: uploadError.message });
    return apiError("INTERNAL", "Upload failed.", { status: 500 });
  }

  const { data: publicUrlData } = admin.storage.from("org-logos").getPublicUrl(objectPath);
  const publicUrl = publicUrlData.publicUrl;

  const { data: updated, error: updateError } = await admin
    .from("organizations")
    .update({ logo_url: publicUrl })
    .eq("id", orgId)
    .select("id, logo_url")
    .single();

  if (updateError || !updated) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to update organization.", internalMessage: updateError?.message || "Unknown error" });
    return apiError("INTERNAL", "Failed to update organization.", { status: 500 });
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "upload_org_logo",
      entity: "storage.org-logos",
      entity_id: orgId,
      metadata: {
        bucket: "org-logos",
        path: objectPath,
        logo_url: publicUrl,
        mime: file.type,
        size: file.size,
      },
    });
  } catch {
    // do not block success
  }

  await logApiEvent({ request, caller, outcome: "success", status: 201, publicMessage: "Organization logo uploaded.", details: { organization_id: orgId } });
  return apiOk({ logo_url: updated.logo_url, path: objectPath }, { status: 201, message: "Organization logo uploaded." });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;

  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (!canManageOrgLogo(caller, orgId)) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  const { data: updated, error: updateError } = await admin
    .from("organizations")
    .update({ logo_url: null })
    .eq("id", orgId)
    .select("id, logo_url")
    .single();

  if (updateError || !updated) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to update organization.", internalMessage: updateError?.message || "Unknown error" });
    return apiError("INTERNAL", "Failed to update organization.", { status: 500 });
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "remove_org_logo",
      entity: "organizations",
      entity_id: orgId,
      metadata: {},
    });
  } catch {
    // do not block success
  }

  await logApiEvent({ request, caller, outcome: "success", status: 200, publicMessage: "Organization logo removed.", details: { organization_id: orgId } });
  return apiOk({ logo_url: null }, { status: 200, message: "Organization logo removed." });
}


