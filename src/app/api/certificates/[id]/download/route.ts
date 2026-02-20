import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { apiError } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Placement = {
  page: number;
  xPct: number;
  yPct: number;
  wPct?: number;
  hPct?: number;
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
};

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function parseHexColor(hex: string | undefined): { r: number; g: number; b: number } | null {
  if (!hex) return null;
  const s = hex.trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (!m) return null;
  const v = m[1];
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return { r: r / 255, g: g / 255, b: b / 255 };
}

function safeFilename(base: string) {
  const s = base.trim().replace(/\s+/g, " ");
  const cleaned = s.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-");
  return cleaned.slice(0, 120) || "certificate";
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: certificateId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({ request, caller: null, outcome: "error", status: 401, code: "UNAUTHORIZED", publicMessage: "Unauthorized" });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  const admin = createAdminSupabaseClient();

  // Load certificate record
  const { data: cert, error: certErr } = await admin
    .from("certificates")
    .select("id, organization_id, user_id, course_id, status, issued_at, storage_bucket, storage_path, file_name, mime_type, size_bytes, generated_at, template_id, course_score_percent")
    .eq("id", certificateId)
    .maybeSingle();

  if (certErr) return apiError("INTERNAL", "Failed to load certificate.", { status: 500 });
  if (!cert?.id) return apiError("NOT_FOUND", "Certificate not found.", { status: 404 });

  // Permission checks (server-side; do not rely on client filtering)
  if (caller.role === "member") {
    if (String((cert as { user_id?: unknown }).user_id ?? "") !== String(caller.id)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  } else if (caller.role === "organization_admin") {
    if (!caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    if (String((cert as { organization_id?: unknown }).organization_id ?? "") !== String(caller.organization_id)) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  } else if (!["super_admin", "system_admin"].includes(caller.role)) {
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const storage_bucket = typeof (cert as { storage_bucket?: unknown }).storage_bucket === "string" ? String((cert as { storage_bucket: string }).storage_bucket) : null;
  const storage_path = typeof (cert as { storage_path?: unknown }).storage_path === "string" ? String((cert as { storage_path: string }).storage_path) : null;

  // If already generated, redirect to signed URL
  if (storage_bucket && storage_path) {
    const { data: signed, error: signedErr } = await admin.storage.from(storage_bucket).createSignedUrl(storage_path, 60 * 10);
    if (signedErr || !signed?.signedUrl) return apiError("INTERNAL", "Failed to create download URL.", { status: 500 });
    return NextResponse.redirect(signed.signedUrl, { status: 302 });
  }

  const courseId = typeof (cert as { course_id?: unknown }).course_id === "string" ? String((cert as { course_id: string }).course_id) : "";
  const userId = typeof (cert as { user_id?: unknown }).user_id === "string" ? String((cert as { user_id: string }).user_id) : "";
  const orgId = typeof (cert as { organization_id?: unknown }).organization_id === "string" ? String((cert as { organization_id: string }).organization_id) : "";
  if (!courseId || !userId || !orgId) return apiError("INTERNAL", "Invalid certificate record.", { status: 500 });

  // Load template + settings
  const [{ data: tpl }, { data: settings }, { data: userRow }, { data: courseRow }] = await Promise.all([
    admin
      .from("course_certificate_templates")
      .select("id, storage_bucket, storage_path, file_name, mime_type")
      .eq("course_id", courseId)
      .maybeSingle(),
    admin
      .from("course_certificate_settings")
      .select("enabled, certificate_title, course_passing_grade_percent, name_placement_json")
      .eq("course_id", courseId)
      .maybeSingle(),
    admin.from("users").select("id, full_name, email").eq("id", userId).maybeSingle(),
    admin.from("courses").select("id, title").eq("id", courseId).maybeSingle(),
  ]);

  if (!tpl?.storage_bucket || !tpl.storage_path) return apiError("NOT_FOUND", "Certificate template not found.", { status: 404 });
  if (!settings?.enabled) return apiError("CONFLICT", "Certificate is not enabled for this course.", { status: 409 });

  const placementRaw = (settings as { name_placement_json?: unknown }).name_placement_json;
  const placement = (placementRaw && typeof placementRaw === "object" ? (placementRaw as Placement) : null) as Placement | null;
  if (!placement || !Number.isFinite(Number(placement.page))) {
    return apiError("CONFLICT", "Certificate name placement is not configured yet.", { status: 409 });
  }

  const displayName =
    (userRow && typeof (userRow as { full_name?: unknown }).full_name === "string" && String((userRow as { full_name: string }).full_name).trim())
      ? String((userRow as { full_name: string }).full_name).trim()
      : (userRow && typeof (userRow as { email?: unknown }).email === "string" ? String((userRow as { email: string }).email) : "Member");

  // Download template bytes
  const { data: file, error: dlErr } = await admin.storage.from(tpl.storage_bucket).download(tpl.storage_path);
  if (dlErr || !file) return apiError("INTERNAL", "Failed to download template.", { status: 500 });
  const templateBytes = await file.arrayBuffer();

  const mime = String((tpl as { mime_type?: unknown }).mime_type ?? "");
  let pdfDoc: PDFDocument;

  if (mime === "application/pdf") {
    pdfDoc = await PDFDocument.load(templateBytes);
  } else if (mime === "image/png" || mime === "image/jpeg") {
    pdfDoc = await PDFDocument.create();
    const embedded = mime === "image/png" ? await pdfDoc.embedPng(templateBytes) : await pdfDoc.embedJpg(templateBytes);
    const { width, height } = embedded.scale(1);
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(embedded, { x: 0, y: 0, width, height });
  } else {
    // WebP not supported by pdf-lib without conversion.
    return apiError("VALIDATION_ERROR", "Unsupported template image type for generation. Please upload PDF, PNG, or JPG.", { status: 400 });
  }

  const pages = pdfDoc.getPages();
  const pageIndex = Math.max(0, Math.min(pages.length - 1, Math.floor(Number(placement.page) - 1)));
  const targetPage = pages[pageIndex];
  const pageW = targetPage.getWidth();
  const pageH = targetPage.getHeight();

  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontSize = Number.isFinite(Number(placement.fontSize)) ? Math.max(6, Math.min(200, Number(placement.fontSize))) : 32;
  const align = placement.align === "left" || placement.align === "right" || placement.align === "center" ? placement.align : "center";
  const color = parseHexColor(placement.color) ?? { r: 0.07, g: 0.07, b: 0.07 };

  const xPct = clamp01(Number(placement.xPct));
  const yPct = clamp01(Number(placement.yPct));

  const textWidth = font.widthOfTextAtSize(displayName, fontSize);
  const xCenter = xPct * pageW;
  const x =
    align === "center" ? xCenter - textWidth / 2 : align === "right" ? xCenter - textWidth : xCenter;

  // placement.yPct is from TOP (as set in the UI). PDF origin is bottom-left.
  const yFromTop = yPct * pageH;
  const y = Math.max(0, pageH - yFromTop - fontSize / 2);

  targetPage.drawText(displayName, {
    x: Math.max(0, Math.min(pageW - 1, x)),
    y: Math.max(0, Math.min(pageH - 1, y)),
    size: fontSize,
    font,
    color: rgb(color.r, color.g, color.b),
  });

  const outBytes = await pdfDoc.save();

  const courseTitle = courseRow && typeof (courseRow as { title?: unknown }).title === "string" ? String((courseRow as { title: string }).title) : "Course";
  const titleBase = typeof (settings as { certificate_title?: unknown }).certificate_title === "string"
    ? String((settings as { certificate_title: string }).certificate_title).trim()
    : "";
  const baseName = safeFilename(titleBase || `Certificate - ${courseTitle}`);
  const fileName = `${baseName}.pdf`;

  const bucket = "certificates";
  const path = `orgs/${orgId}/courses/${courseId}/users/${userId}/cert-${certificateId}.pdf`;

  const uploadRes = await admin.storage.from(bucket).upload(path, outBytes, { contentType: "application/pdf", upsert: true });
  if (uploadRes.error) return apiError("INTERNAL", "Failed to store generated certificate.", { status: 500 });

  const now = new Date().toISOString();
  const { error: updErr } = await admin
    .from("certificates")
    .update({
      storage_bucket: bucket,
      storage_path: path,
      file_name: fileName,
      mime_type: "application/pdf",
      size_bytes: outBytes.byteLength,
      generated_at: now,
      template_id: (tpl as { id?: unknown }).id ?? null,
    })
    .eq("id", certificateId);
  if (updErr) return apiError("INTERNAL", "Failed to save generated certificate metadata.", { status: 500 });

  const { data: signed2, error: signedErr2 } = await admin.storage.from(bucket).createSignedUrl(path, 60 * 10);
  if (signedErr2 || !signed2?.signedUrl) return apiError("INTERNAL", "Failed to create download URL.", { status: 500 });

  return NextResponse.redirect(signed2.signedUrl, { status: 302 });
}

