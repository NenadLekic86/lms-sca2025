import { NextRequest } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { validateSchema } from "@/lib/validations/schemas";
import { z } from "zod";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

const addVideoSchema = z.object({
  url: z.string().trim().min(8, "URL is required").url("Invalid URL"),
});

function extractIframeSrc(html: string): string | null {
  const m = html.match(/src="([^"]+)"/i);
  const src = m?.[1] ?? null;
  if (!src) return null;
  try {
    const u = new URL(src);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function tryOEmbed(url: string): Promise<{
  provider: string | null;
  title: string | null;
  thumbnail_url: string | null;
  embed_url: string | null;
}> {
  let provider: string | null = null;
  let endpoint: string | null = null;

  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isYouTube = host.includes("youtube.com") || host === "youtu.be";
    const isVimeo = host.includes("vimeo.com");

    if (isYouTube) {
      provider = "youtube";
      endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
    } else if (isVimeo) {
      provider = "vimeo";
      endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
    } else {
      provider = "other";
      endpoint = null;
    }
  } catch {
    return { provider: null, title: null, thumbnail_url: null, embed_url: null };
  }

  if (!endpoint) return { provider, title: null, thumbnail_url: null, embed_url: null };

  try {
    const res = await fetch(endpoint, { cache: "no-store" });
    if (!res.ok) return { provider, title: null, thumbnail_url: null, embed_url: null };
    const json = (await res.json().catch(() => null)) as { title?: unknown; thumbnail_url?: unknown; html?: unknown } | null;
    if (!json) return { provider, title: null, thumbnail_url: null, embed_url: null };

    const title = typeof json.title === "string" ? json.title : null;
    const thumbnail_url = typeof json.thumbnail_url === "string" ? json.thumbnail_url : null;
    const html = typeof json.html === "string" ? json.html : "";
    const embed_url = html ? extractIframeSrc(html) : null;

    return { provider, title, thumbnail_url, embed_url };
  } catch {
    return { provider, title: null, thumbnail_url: null, embed_url: null };
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
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

  const supabase = await createServerSupabaseClient();
  const { data, error: loadError } = await supabase
    .from("course_videos")
    .select("id, created_at, course_id, provider, original_url, embed_url, title, thumbnail_url")
    .eq("course_id", id)
    .order("created_at", { ascending: false });

  if (loadError) return apiError("INTERNAL", "Failed to load videos.", { status: 500 });
  return apiOk({ videos: Array.isArray(data) ? data : [] }, { status: 200 });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
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

  if (!["super_admin", "system_admin", "organization_admin"].includes(caller.role)) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const validation = validateSchema(addVideoSchema, body);
  if (!validation.success) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: validation.error });
    return apiError("VALIDATION_ERROR", validation.error, { status: 400 });
  }

  const url = validation.data.url;

  const admin = createAdminSupabaseClient();
  const { data: courseRow, error: courseError } = await admin
    .from("courses")
    .select("id, organization_id")
    .eq("id", id)
    .single();

  if (courseError || !courseRow) {
    return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  }

  if (caller.role === "organization_admin") {
    if (!caller.organization_id || courseRow.organization_id !== caller.organization_id) {
      await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }
  }

  const oembed = await tryOEmbed(url);

  const { data: inserted, error: insertError } = await admin
    .from("course_videos")
    .insert({
      course_id: id,
      organization_id: courseRow.organization_id,
      provider: oembed.provider,
      original_url: url,
      embed_url: oembed.embed_url,
      title: oembed.title,
      thumbnail_url: oembed.thumbnail_url,
      created_by: caller.id,
    })
    .select("id, created_at, provider, original_url, embed_url, title, thumbnail_url")
    .single();

  if (insertError || !inserted) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to save video.", internalMessage: insertError?.message });
    return apiError("INTERNAL", "Failed to save video.", { status: 500 });
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "add_course_video",
      entity: "courses",
      entity_id: id,
      metadata: { url, provider: oembed.provider, ok: Boolean(oembed.embed_url) },
    });
  } catch {
    // ignore
  }

  await logApiEvent({ request, caller, outcome: "success", status: 201, publicMessage: "Video added.", details: { course_id: id, ok: Boolean(oembed.embed_url) } });
  return apiOk({ video: inserted }, { status: 201, message: "Video added." });
}

