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

export function coerceNullableText(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const v = input.trim();
  return v.length ? v : null;
}

