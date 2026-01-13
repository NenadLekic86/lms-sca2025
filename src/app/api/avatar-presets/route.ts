import { NextResponse } from "next/server";
import { getServerUser } from "@/lib/supabase/server";
import path from "path";
import { readdir } from "fs/promises";

export const runtime = "nodejs";

const PRESETS_DIR = path.join(process.cwd(), "public", "avatars", "presets");

export async function GET() {
  const { user, error } = await getServerUser();
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const files = await readdir(PRESETS_DIR, { withFileTypes: true });
    const presets = files
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((name) => /\.(png|webp|jpe?g|svg)$/i.test(name))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, url: `/avatars/presets/${name}` }));

    return NextResponse.json({ presets });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load avatar presets" },
      { status: 500 }
    );
  }
}


