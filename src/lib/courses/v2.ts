import DOMPurify from "isomorphic-dompurify";
import { createAdminSupabaseClient } from "@/lib/supabase/server";
import { normalizeSlug, coursePermalink } from "@/lib/courses/v2.shared";

export type CourseDifficultyLevel = "all_levels" | "beginner" | "intermediate" | "expert";
export type CourseStatus = "draft" | "published";
export type IntroVideoProvider = "html5" | "youtube" | "vimeo";
export type CourseItemType = "lesson" | "quiz";
export { normalizeSlug, coursePermalink };

export async function ensureUniqueCourseSlug(opts: {
  organizationId: string;
  titleOrSlug: string;
  excludeCourseId?: string;
}): Promise<string> {
  const admin = createAdminSupabaseClient();
  const base = normalizeSlug(opts.titleOrSlug);

  for (let i = 0; i < 200; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    let q = admin
      .from("courses")
      .select("id")
      .eq("organization_id", opts.organizationId)
      .eq("slug", candidate)
      .limit(1);
    if (opts.excludeCourseId) q = q.neq("id", opts.excludeCourseId);
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`Failed to validate slug uniqueness: ${error.message}`);
    if (!data?.id) return candidate;
  }

  throw new Error("Failed to generate unique slug.");
}

export function sanitizeRichHtml(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const clean = DOMPurify.sanitize(trimmed, {
    USE_PROFILES: { html: true },
    // Allow our controlled richtext attributes for security-safe styling.
    ADD_ATTR: ["data-rt-color", "data-rt-bg", "data-callout", "data-callout-body"],
  });
  return clean.trim() || null;
}

export function hasMeaningfulHtmlContent(input: string | null | undefined): boolean {
  const clean = sanitizeRichHtml(input);
  if (!clean) return false;
  // Strip tags and decode common HTML entities so empty markup like <p><br></p> does not pass.
  const text = clean
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text.length >= 8;
}

export function coerceNullableText(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const v = input.trim();
  return v.length ? v : null;
}

