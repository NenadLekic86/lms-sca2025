import { NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

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
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canManageOrgLogo(caller, orgId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Invalid form data" }, { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: `Invalid file type. Allowed: ${Array.from(ALLOWED_MIME).join(", ")}` },
      { status: 400 }
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 2MB)" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Ensure org exists (and provides better error than silent update miss)
  const { data: org, error: orgError } = await admin.from("organizations").select("id").eq("id", orgId).single();
  if (orgError || !org?.id) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
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
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
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
    return NextResponse.json(
      { error: `Failed to update organization: ${updateError?.message || "Unknown error"}` },
      { status: 500 }
    );
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

  return NextResponse.json(
    {
      message: "Organization logo uploaded",
      logo_url: updated.logo_url,
      path: objectPath,
    },
    { status: 201 }
  );
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;

  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canManageOrgLogo(caller, orgId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminSupabaseClient();

  const { data: updated, error: updateError } = await admin
    .from("organizations")
    .update({ logo_url: null })
    .eq("id", orgId)
    .select("id, logo_url")
    .single();

  if (updateError || !updated) {
    return NextResponse.json(
      { error: `Failed to update organization: ${updateError?.message || "Unknown error"}` },
      { status: 500 }
    );
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

  return NextResponse.json({ message: "Organization logo removed", logo_url: null }, { status: 200 });
}


