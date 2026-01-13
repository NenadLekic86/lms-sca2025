import { NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_MIME = new Set(["image/png", "image/webp", "image/jpeg", "image/jpg"]);

function getExt(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    default:
      return "bin";
  }
}

function parsePublicObjectPath(publicUrl: string, bucket: string): string | null {
  // Expected:
  // https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
  try {
    const url = new URL(publicUrl);
    const needle = `/storage/v1/object/public/${bucket}/`;
    const idx = url.pathname.indexOf(needle);
    if (idx === -1) return null;
    return url.pathname.slice(idx + needle.length);
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
  const bucket = "user-avatars";

  // Load previous avatar_url (for best-effort cleanup)
  const { data: currentUser, error: currentErr } = await admin
    .from("users")
    .select("id, avatar_url")
    .eq("id", caller.id)
    .single();

  if (currentErr || !currentUser) {
    return NextResponse.json({ error: "Failed to load profile" }, { status: 500 });
  }

  const previousAvatarUrl = (currentUser as { avatar_url?: unknown }).avatar_url;
  const previousPath =
    typeof previousAvatarUrl === "string" ? parsePublicObjectPath(previousAvatarUrl, bucket) : null;

  const ext = getExt(file.type);
  const ts = Date.now();
  const objectPath = `users/${caller.id}/avatar-${ts}.${ext}`;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: uploadError } = await admin.storage.from(bucket).upload(objectPath, bytes, {
    contentType: file.type,
    upsert: true,
    cacheControl: "3600",
  });

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  const { data: publicUrlData } = admin.storage.from(bucket).getPublicUrl(objectPath);
  const publicUrl = publicUrlData.publicUrl;

  // Update DB
  const { data: updated, error: updateError } = await admin
    .from("users")
    .update({ avatar_url: publicUrl })
    .eq("id", caller.id)
    .select("id, avatar_url")
    .single();

  if (updateError || !updated) {
    return NextResponse.json({ error: updateError?.message || "Failed to update profile" }, { status: 500 });
  }

  // Best-effort cleanup of previous object
  if (previousPath && previousPath !== objectPath) {
    try {
      await admin.storage.from(bucket).remove([previousPath]);
    } catch {
      // ignore
    }
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "upload_user_avatar",
      entity: `storage.${bucket}`,
      entity_id: caller.id,
      target_user_id: caller.id,
      metadata: {
        bucket,
        path: objectPath,
        avatar_url: publicUrl,
        previous_avatar_url: typeof previousAvatarUrl === "string" ? previousAvatarUrl : null,
        mime: file.type,
        size: file.size,
      },
    });
  } catch {
    // ignore
  }

  return NextResponse.json(
    {
      message: "Avatar uploaded",
      avatar_url: (updated as { avatar_url?: unknown }).avatar_url ?? null,
    },
    { status: 201 }
  );
}

export async function DELETE() {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminSupabaseClient();
  const bucket = "user-avatars";

  // Load current avatar_url for cleanup
  const { data: currentUser, error: currentErr } = await admin
    .from("users")
    .select("id, avatar_url")
    .eq("id", caller.id)
    .single();

  if (currentErr || !currentUser) {
    return NextResponse.json({ error: "Failed to load profile" }, { status: 500 });
  }

  const previousAvatarUrl = (currentUser as { avatar_url?: unknown }).avatar_url;
  const previousPath =
    typeof previousAvatarUrl === "string" ? parsePublicObjectPath(previousAvatarUrl, bucket) : null;

  const { error: updateError } = await admin
    .from("users")
    .update({ avatar_url: null })
    .eq("id", caller.id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message || "Failed to remove avatar" }, { status: 500 });
  }

  if (previousPath) {
    try {
      await admin.storage.from(bucket).remove([previousPath]);
    } catch {
      // ignore
    }
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "remove_user_avatar",
      entity: `storage.${bucket}`,
      entity_id: caller.id,
      target_user_id: caller.id,
      metadata: {
        bucket,
        previous_avatar_url: typeof previousAvatarUrl === "string" ? previousAvatarUrl : null,
      },
    });
  } catch {
    // ignore
  }

  return NextResponse.json({ message: "Avatar removed", avatar_url: null }, { status: 200 });
}


