import "server-only";

import sanitizeHtml from "sanitize-html";

// This sanitizer is used for course/lesson/quiz rich HTML that will be rendered via dangerouslySetInnerHTML.
// Keep the allowlist tight and aligned with our TipTap editor output:
// - data-rt-color / data-rt-bg marks
// - callout node: div[data-callout] + inner div[data-callout-body]
// - inline images (src is rewritten to a stable /api/v2/* URL on save)
// - optional iframe embeds (restricted to YouTube/Vimeo embed URLs)

const ALLOWED_TAGS: sanitizeHtml.IOptions["allowedTags"] = [
  "p",
  "br",
  "strong",
  "em",
  "u",
  "s",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "code",
  "hr",
  "a",
  "span",
  "div",
  "img",
  "iframe",
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  a: ["href", "name", "target", "rel"],
  img: ["src", "alt", "title", "width", "height", "data-inline-upload-id"],
  iframe: ["src", "title", "allow", "allowfullscreen", "referrerpolicy"],
  span: ["data-rt-color", "data-rt-bg"],
  div: ["data-callout", "data-callout-body"],
  // TipTap TextAlign uses inline style for text-align.
  p: ["style"],
  h1: ["style"],
  h2: ["style"],
  h3: ["style"],
  h4: ["style"],
  h5: ["style"],
  h6: ["style"],
};

const ALLOWED_STYLES: sanitizeHtml.IOptions["allowedStyles"] = {
  p: { "text-align": [/^(left|right|center|justify)$/] },
  h1: { "text-align": [/^(left|right|center|justify)$/] },
  h2: { "text-align": [/^(left|right|center|justify)$/] },
  h3: { "text-align": [/^(left|right|center|justify)$/] },
  h4: { "text-align": [/^(left|right|center|justify)$/] },
  h5: { "text-align": [/^(left|right|center|justify)$/] },
  h6: { "text-align": [/^(left|right|center|justify)$/] },
};

function isAllowedImageSrc(src: string): boolean {
  const s = src.trim();
  if (!s) return false;

  // Allow our own stable asset URLs (preferred).
  if (s.startsWith("/api/v2/course-assets?path=")) return true;
  if (s.startsWith("/api/v2/lesson-assets?path=")) return true;

  // Allow https images (covers Supabase public objects and any allowed external images).
  if (/^https:\/\//i.test(s)) return true;

  // Allow base64 images (TipTap Image can generate these; useful for previews).
  // Restrict to image mime types only.
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return true;

  return false;
}

function isAllowedIframeSrc(src: string): boolean {
  const s = src.trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    const path = u.pathname;

    // YouTube embed only.
    if ((host === "www.youtube.com" || host === "youtube.com") && path.startsWith("/embed/")) return true;

    // Vimeo embed only.
    if (host === "player.vimeo.com" && path.startsWith("/video/")) return true;

    return false;
  } catch {
    return false;
  }
}

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedStyles: ALLOWED_STYLES,

  // Safe URL schemes for links.
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
    iframe: ["https"],
  },
  allowProtocolRelative: false,

  transformTags: {
    a: (tagName, attribs) => {
      const next = { ...attribs };
      const target = (next.target ?? "").toLowerCase();
      if (target === "_blank") {
        const rel = (next.rel ?? "").toLowerCase();
        const parts = new Set(rel.split(/\s+/).filter(Boolean));
        parts.add("noopener");
        parts.add("noreferrer");
        next.rel = Array.from(parts).join(" ");
      }
      return { tagName, attribs: next };
    },
    img: (tagName, attribs) => {
      const src = (attribs.src ?? "").toString().trim();
      if (!isAllowedImageSrc(src)) {
        // Drop unsafe images entirely.
        return { tagName: "span", attribs: {} as sanitizeHtml.Attributes } as sanitizeHtml.Tag;
      }
      return { tagName, attribs: { ...attribs, src } as sanitizeHtml.Attributes } as sanitizeHtml.Tag;
    },
    iframe: (tagName, attribs) => {
      const src = (attribs.src ?? "").toString().trim();
      if (!isAllowedIframeSrc(src)) {
        // Drop unsafe iframes entirely.
        return { tagName: "span", attribs: {} as sanitizeHtml.Attributes } as sanitizeHtml.Tag;
      }
      return {
        tagName: "iframe",
        attribs: {
          src,
          title: (attribs.title ?? "Embedded video").toString(),
          allow: (
            attribs.allow ??
            "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          ).toString(),
          allowfullscreen: "true",
          referrerpolicy: (attribs.referrerpolicy ?? "strict-origin-when-cross-origin").toString(),
        } as sanitizeHtml.Attributes,
      } as sanitizeHtml.Tag;
    },
  },
};

export function sanitizeRichHtml(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const clean = sanitizeHtml(trimmed, SANITIZE_OPTS).trim();
  return clean || null;
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

