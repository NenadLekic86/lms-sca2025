export function normalizeSlug(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "course";
}

export function coursePermalink(input: { origin: string; orgSlug: string; slug: string }): string {
  const org = encodeURIComponent(input.orgSlug);
  const slug = encodeURIComponent(input.slug);
  return `${input.origin}/org/${org}/courses/${slug}`;
}

