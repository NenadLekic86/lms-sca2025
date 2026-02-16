import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { patchCourseV2Schema, validateSchema } from "@/lib/validations/schemas";
import { coerceNullableText, coursePermalink, ensureUniqueCourseSlug, sanitizeRichHtml } from "@/lib/courses/v2";

type CourseRow = {
  id: string;
  organization_id: string | null;
  title: string | null;
  slug: string | null;
  status: "draft" | "published" | null;
  is_published: boolean | null;
  about_html: string | null;
  excerpt: string | null;
  difficulty_level: "all_levels" | "beginner" | "intermediate" | "expert" | null;
  what_will_learn: string | null;
  total_duration_hours: number | null;
  total_duration_minutes: number | null;
  materials_included: string | null;
  requirements_instructions: string | null;
  intro_video_provider: "html5" | "youtube" | "vimeo" | null;
  intro_video_url: string | null;
  intro_video_storage_path: string | null;
  intro_video_size_bytes: number | null;
  intro_video_mime: string | null;
  cover_image_url: string | null;
  thumbnail_storage_path: string | null;
  builder_version: number | null;
  created_at: string | null;
  updated_at: string | null;
};

export const runtime = "nodejs";

function isOrgAdminOwner(caller: { role: string; organization_id?: string | null }, course: { organization_id: string | null }): boolean {
  return caller.role === "organization_admin" && !!caller.organization_id && caller.organization_id === course.organization_id;
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
  if (host === "youtu.be" || hostMatches(host, "youtu.be")) return parsed.pathname.length > 1;
  if (!hostMatches(host, "youtube.com")) return false;
  if (parsed.pathname.startsWith("/watch")) return parsed.searchParams.has("v");
  if (parsed.pathname.startsWith("/shorts/")) return true;
  if (parsed.pathname.startsWith("/embed/")) return true;
  return false;
}

function isVimeoUrl(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();
  if (!hostMatches(host, "vimeo.com")) return false;
  return parsed.pathname.length > 1;
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  if (caller.role !== "organization_admin") {
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  const { data: courseData, error: courseError } = await admin
    .from("courses")
    .select(
      "id, organization_id, title, slug, status, is_published, about_html, excerpt, difficulty_level, what_will_learn, total_duration_hours, total_duration_minutes, materials_included, requirements_instructions, intro_video_provider, intro_video_url, intro_video_storage_path, intro_video_size_bytes, intro_video_mime, cover_image_url, thumbnail_storage_path, builder_version, created_at, updated_at"
    )
    .eq("id", id)
    .single();

  if (courseError || !courseData) {
    return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  }

  const course = courseData as CourseRow;
  if (!isOrgAdminOwner(caller, course)) {
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const [{ data: topicsData }, { data: itemsData }, { data: assignedData }, { data: orgRow }] = await Promise.all([
    admin
      .from("course_topics")
      .select("id, title, summary, position, created_at, updated_at")
      .eq("course_id", id)
      .order("position", { ascending: true }),
    admin
      .from("course_topic_items")
      .select("id, topic_id, item_type, title, position, payload_json, is_required, created_at, updated_at")
      .eq("course_id", id)
      .order("position", { ascending: true }),
    admin.from("course_member_assignments").select("user_id").eq("course_id", id).eq("organization_id", caller.organization_id!),
    admin.from("organizations").select("slug").eq("id", caller.organization_id!).maybeSingle(),
  ]);

  const orgSlug = typeof orgRow?.slug === "string" && orgRow.slug.trim().length > 0 ? orgRow.slug.trim() : caller.organization_id!;
  const origin = new URL(request.url).origin;
  const permalink = coursePermalink({
    origin,
    orgSlug,
    slug: course.slug ?? "course",
  });

  const assignedMemberIds = (Array.isArray(assignedData) ? assignedData : [])
    .map((r) => r.user_id)
    .filter((v): v is string => typeof v === "string");

  const itemsByTopic = new Map<string, Array<Record<string, unknown>>>();
  for (const row of Array.isArray(itemsData) ? itemsData : []) {
    const topicId = typeof row.topic_id === "string" ? row.topic_id : "";
    if (!topicId) continue;
    const arr = itemsByTopic.get(topicId) ?? [];
    arr.push({
      id: row.id,
      item_type: row.item_type,
      title: row.title,
      position: row.position,
      payload_json: row.payload_json ?? {},
      is_required: row.is_required ?? true,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
    itemsByTopic.set(topicId, arr);
  }

  const topics = (Array.isArray(topicsData) ? topicsData : []).map((t) => ({
    id: t.id,
    title: t.title,
    summary: t.summary,
    position: t.position,
    created_at: t.created_at,
    updated_at: t.updated_at,
    items: itemsByTopic.get(t.id) ?? [],
  }));

  return apiOk(
    {
      course: {
        ...course,
        permalink,
        assigned_member_ids: assignedMemberIds,
      },
      topics,
    },
    { status: 200 }
  );
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({ request, caller: null, outcome: "error", status: 401, code: "UNAUTHORIZED", publicMessage: "Unauthorized" });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  if (caller.role !== "organization_admin" || !caller.organization_id) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = validateSchema(patchCourseV2Schema, body);
  if (!parsed.success) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: parsed.error });
    return apiError("VALIDATION_ERROR", parsed.error, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data: currentData, error: currentError } = await admin
    .from("courses")
    .select("id, organization_id, title, slug, intro_video_provider, intro_video_url")
    .eq("id", id)
    .single();

  if (currentError || !currentData) {
    return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  }
  if ((currentData.organization_id ?? null) !== caller.organization_id) {
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const patch = parsed.data;
  const updatePayload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (Object.prototype.hasOwnProperty.call(patch, "title")) {
    updatePayload.title = patch.title?.trim();
  }

  if (Object.prototype.hasOwnProperty.call(patch, "slug")) {
    if (patch.slug) {
      try {
        updatePayload.slug = await ensureUniqueCourseSlug({
          organizationId: caller.organization_id,
          titleOrSlug: patch.slug,
          excludeCourseId: id,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Slug conflict";
        return apiError("CONFLICT", message, { status: 409 });
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "about_html")) {
    updatePayload.about_html = sanitizeRichHtml(patch.about_html);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "excerpt")) {
    updatePayload.excerpt = coerceNullableText(patch.excerpt);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "difficulty_level")) {
    updatePayload.difficulty_level = patch.difficulty_level;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "what_will_learn")) {
    updatePayload.what_will_learn = coerceNullableText(patch.what_will_learn);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "total_duration_hours")) {
    updatePayload.total_duration_hours = patch.total_duration_hours;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "total_duration_minutes")) {
    updatePayload.total_duration_minutes = patch.total_duration_minutes;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "materials_included")) {
    updatePayload.materials_included = coerceNullableText(patch.materials_included);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "requirements_instructions")) {
    updatePayload.requirements_instructions = coerceNullableText(patch.requirements_instructions);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "intro_video_provider")) {
    updatePayload.intro_video_provider = patch.intro_video_provider;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "intro_video_url")) {
    updatePayload.intro_video_url = coerceNullableText(patch.intro_video_url);
  }

  const resolvedProvider =
    typeof updatePayload.intro_video_provider === "string"
      ? (updatePayload.intro_video_provider as "html5" | "youtube" | "vimeo")
      : (currentData.intro_video_provider ?? null);
  const resolvedVideoUrl =
    typeof updatePayload.intro_video_url === "string"
      ? (updatePayload.intro_video_url as string)
      : (currentData.intro_video_url ?? null);

  if (resolvedProvider && resolvedProvider !== "html5" && resolvedVideoUrl) {
    const parsedVideoUrl = parseExternalVideoUrl(resolvedVideoUrl);
    if (!parsedVideoUrl) {
      return apiError("VALIDATION_ERROR", "Invalid intro video URL.", { status: 400 });
    }
    if (resolvedProvider === "youtube" && !isYouTubeUrl(parsedVideoUrl)) {
      return apiError("VALIDATION_ERROR", "Please provide a full YouTube URL.", { status: 400 });
    }
    if (resolvedProvider === "vimeo" && !isVimeoUrl(parsedVideoUrl)) {
      return apiError("VALIDATION_ERROR", "Please provide a full Vimeo URL.", { status: 400 });
    }
  }

  const { data: updatedData, error: updateError } = await admin
    .from("courses")
    .update(updatePayload)
    .eq("id", id)
    .select(
      "id, organization_id, title, slug, status, is_published, about_html, excerpt, difficulty_level, what_will_learn, total_duration_hours, total_duration_minutes, materials_included, requirements_instructions, intro_video_provider, intro_video_url, intro_video_storage_path, intro_video_size_bytes, intro_video_mime, cover_image_url, thumbnail_storage_path, builder_version, created_at, updated_at"
    )
    .single();

  if (updateError || !updatedData) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to update course.",
      internalMessage: updateError?.message,
    });
    return apiError("INTERNAL", "Failed to update course.", { status: 500 });
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Course updated.",
    details: { course_id: id, patch_keys: Object.keys(updatePayload) },
  });

  return apiOk({ course: updatedData }, { status: 200, message: "Course updated." });
}

