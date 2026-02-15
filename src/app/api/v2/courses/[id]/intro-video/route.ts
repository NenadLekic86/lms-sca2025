import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { introVideoProviderSchema, validateSchema } from "@/lib/validations/schemas";

function getExtFromMime(mime: string): string {
  if (mime === "video/mp4") return "mp4";
  return "bin";
}

function parseExternalVideoUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hostMatches(hostname: string, baseDomain: string): boolean {
  return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
}

function isYouTubeUrl(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();
  if (host === "youtu.be" || hostMatches(host, "youtu.be")) {
    return parsed.pathname.length > 1;
  }

  if (!hostMatches(host, "youtube.com")) return false;
  if (parsed.pathname.startsWith("/watch")) return parsed.searchParams.has("v");
  if (parsed.pathname.startsWith("/shorts/")) return true;
  if (parsed.pathname.startsWith("/embed/")) return true;
  return false;
}

function isVimeoUrl(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();
  if (!hostMatches(host, "vimeo.com")) return false;
  // Keep this broad for Vimeo share URLs while still constraining trusted hostnames.
  return parsed.pathname.length > 1;
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const form = await request.formData().catch(() => null);
  if (!form) return apiError("VALIDATION_ERROR", "Invalid form data.", { status: 400 });

  const providerRaw = form.get("provider");
  const providerParsed = validateSchema(introVideoProviderSchema, providerRaw);
  if (!providerParsed.success) return apiError("VALIDATION_ERROR", "Invalid intro video provider.", { status: 400 });
  const provider = providerParsed.data;

  const admin = createAdminSupabaseClient();
  const { data: row, error: rowError } = await admin
    .from("courses")
    .select("id, organization_id")
    .eq("id", id)
    .single();
  if (rowError || !row?.id) return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  if (row.organization_id !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const now = new Date().toISOString();

  if (provider === "html5") {
    const file = form.get("file");
    if (!(file instanceof File)) {
      return apiError("VALIDATION_ERROR", "Missing video file.", { status: 400 });
    }

    if (file.type !== "video/mp4") {
      return apiError("VALIDATION_ERROR", "Invalid file type (allowed: MP4).", { status: 400 });
    }

    const maxBytes = 50 * 1024 * 1024; // 50MB
    if (file.size > maxBytes) {
      return apiError("VALIDATION_ERROR", "File too large (max 50MB).", { status: 400 });
    }

    const ext = getExtFromMime(file.type);
    const ts = Date.now();
    const path = `${caller.organization_id}/${id}/intro-${ts}.${ext}`;

    const bytes = await file.arrayBuffer();
    const uploadRes = await admin.storage.from("course-intro-videos").upload(path, bytes, {
      contentType: file.type,
      upsert: true,
    });
    if (uploadRes.error) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Intro video upload failed.",
        internalMessage: uploadRes.error.message,
      });
      return apiError("INTERNAL", "Intro video upload failed.", { status: 500 });
    }

    const { error: updateError } = await admin
      .from("courses")
      .update({
        intro_video_provider: "html5",
        intro_video_url: null,
        intro_video_storage_path: path,
        intro_video_size_bytes: file.size,
        intro_video_mime: file.type,
        updated_at: now,
      })
      .eq("id", id);

    if (updateError) return apiError("INTERNAL", "Failed to save intro video.", { status: 500 });

    return apiOk(
      {
        intro_video: {
          provider: "html5",
          url: null,
          storage_path: path,
          size_bytes: file.size,
          mime: file.type,
        },
      },
      { status: 200, message: "Intro video saved." }
    );
  }

  const urlRaw = form.get("url");
  const url = typeof urlRaw === "string" ? urlRaw.trim() : "";
  if (!url) return apiError("VALIDATION_ERROR", "Video URL is required.", { status: 400 });

  const parsedUrl = parseExternalVideoUrl(url);
  if (!parsedUrl) {
    return apiError("VALIDATION_ERROR", "Invalid video URL.", { status: 400 });
  }

  if (provider === "youtube" && !isYouTubeUrl(parsedUrl)) {
    return apiError("VALIDATION_ERROR", "Please provide a full YouTube URL.", { status: 400 });
  }
  if (provider === "vimeo" && !isVimeoUrl(parsedUrl)) {
    return apiError("VALIDATION_ERROR", "Please provide a full Vimeo URL.", { status: 400 });
  }

  const { error: updateError } = await admin
    .from("courses")
    .update({
      intro_video_provider: provider,
      intro_video_url: url,
      intro_video_storage_path: null,
      intro_video_size_bytes: null,
      intro_video_mime: null,
      updated_at: now,
    })
    .eq("id", id);
  if (updateError) return apiError("INTERNAL", "Failed to save intro video URL.", { status: 500 });

  return apiOk(
    {
      intro_video: {
        provider,
        url,
        storage_path: null,
      },
    },
    { status: 200, message: "Intro video URL saved." }
  );
}

