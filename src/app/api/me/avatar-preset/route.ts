import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import path from "path";
import { access } from "fs/promises";

export const runtime = "nodejs";

const PRESETS_DIR = path.join(process.cwd(), "public", "avatars", "presets");
const BUCKET = "user-avatars";

function getRequestOrigin(request: NextRequest): string | null {
  const direct = request.headers.get("origin");
  if (direct && direct.trim().length > 0) return direct.trim();

  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.split(",")[0]?.trim() ||
    "";
  if (host) return `${proto}://${host}`;

  const env = process.env.NEXT_PUBLIC_APP_URL;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();

  return null;
}

function parsePublicObjectPath(publicUrl: string, bucket: string): string | null {
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

function isSafeFileName(name: string): boolean {
  // allow letters, numbers, dash, underscore, dot
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

export async function POST(request: NextRequest) {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const nameRaw = (body as { name?: unknown } | null)?.name;
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!name || !isSafeFileName(name)) {
    return NextResponse.json({ error: "Invalid preset name" }, { status: 400 });
  }
  if (!/\.(png|webp|jpe?g|svg)$/i.test(name)) {
    return NextResponse.json({ error: "Invalid preset file type" }, { status: 400 });
  }

  // Ensure preset exists on disk
  const presetPath = path.join(PRESETS_DIR, name);
  try {
    await access(presetPath);
  } catch {
    return NextResponse.json({ error: "Preset not found" }, { status: 404 });
  }

  const admin = createAdminSupabaseClient();

  // Load previous avatar_url for best-effort cleanup of old uploaded avatar
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
    typeof previousAvatarUrl === "string" ? parsePublicObjectPath(previousAvatarUrl, BUCKET) : null;

  const nextPath = `/avatars/presets/${name}`;
  const origin = getRequestOrigin(request);
  if (!origin) {
    return NextResponse.json({ error: "Could not determine app origin for preset URL" }, { status: 500 });
  }
  const nextUrl = `${origin}${nextPath}`;

  const { error: updateError } = await admin
    .from("users")
    .update({ avatar_url: nextUrl })
    .eq("id", caller.id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message || "Failed to set avatar preset" }, { status: 500 });
  }

  if (previousPath) {
    try {
      await admin.storage.from(BUCKET).remove([previousPath]);
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
      action: "set_user_avatar_preset",
      entity: "avatars.presets",
      entity_id: caller.id,
      target_user_id: caller.id,
      metadata: {
        preset_name: name,
        avatar_url: nextUrl,
        avatar_path: nextPath,
        previous_avatar_url: typeof previousAvatarUrl === "string" ? previousAvatarUrl : null,
      },
    });
  } catch {
    // ignore
  }

  return NextResponse.json({ message: "Avatar preset set", avatar_url: nextUrl }, { status: 200 });
}


