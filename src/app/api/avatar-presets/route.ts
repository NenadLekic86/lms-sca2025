import { getServerUser } from "@/lib/supabase/server";
import path from "path";
import { readdir } from "fs/promises";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

const PRESETS_DIR = path.join(process.cwd(), "public", "avatars", "presets");

export async function GET(request: Request) {
  const { user, error } = await getServerUser();
  if (error || !user) {
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

  try {
    const files = await readdir(PRESETS_DIR, { withFileTypes: true });
    const presets = files
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((name) => /\.(png|webp|jpe?g|svg)$/i.test(name))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, url: `/avatars/presets/${name}` }));

    return apiOk({ presets }, { status: 200 });
  } catch {
    return apiError("INTERNAL", "Failed to load avatar presets.", { status: 500 });
  }
}


