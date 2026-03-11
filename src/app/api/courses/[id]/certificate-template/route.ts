import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

const PREVIEW_NAME = "Olivia Jane";

type Placement = {
  page: number;
  xPct: number;
  yPct: number;
  wPct?: number;
  hPct?: number;
  fontSize?: number;
  fontFamily?: "helvetica" | "helvetica_bold" | "times" | "times_bold" | "courier" | "courier_bold";
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

function pickStandardFontName(family: Placement["fontFamily"] | undefined): StandardFonts {
  if (family === "helvetica") return StandardFonts.Helvetica;
  if (family === "times") return StandardFonts.TimesRoman;
  if (family === "times_bold") return StandardFonts.TimesRomanBold;
  if (family === "courier") return StandardFonts.Courier;
  if (family === "courier_bold") return StandardFonts.CourierBold;
  return StandardFonts.HelveticaBold;
}

function fitFontSizeToWidth(args: {
  font: { widthOfTextAtSize: (text: string, size: number) => number };
  text: string;
  desired: number;
  maxWidth: number | null;
}): number {
  const desired = Math.max(6, Math.min(200, args.desired));
  if (!args.maxWidth || args.maxWidth <= 0) return desired;
  let s = desired;
  for (let i = 0; i < 60; i++) {
    const w = args.font.widthOfTextAtSize(args.text, s);
    if (w <= args.maxWidth || s <= 6) break;
    s = Math.max(6, s - 1);
  }
  return s;
}

function getExtFromMime(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "bin";
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

  const url = new URL(request.url);
  const download = url.searchParams.get("download") === "1";
  const preview = url.searchParams.get("preview") === "1";

  // Default behavior: return template metadata (used by course builder Step 4).
  if (!download) {
    // Use session client for RLS.
    const supabase = await createServerSupabaseClient();
    const { data, error: loadError } = await supabase
      .from("course_certificate_templates")
      .select("id, created_at, course_id, storage_bucket, storage_path, file_name, mime_type, size_bytes")
      .eq("course_id", id)
      .maybeSingle();

    if (loadError) return apiError("INTERNAL", "Failed to load certificate template.", { status: 500 });
    return apiOk({ template: data ?? null }, { status: 200 });
  }

  // Download behavior (v1): allow downloading the course's certificate template
  // only if the caller is authorized.
  const admin = createAdminSupabaseClient();

  if (caller.role === "member") {
    const { data: cert } = await admin
      .from("certificates")
      .select("id")
      .eq("course_id", id)
      .eq("user_id", caller.id)
      .limit(1)
      .maybeSingle();

    if (!cert?.id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  } else if (caller.role === "organization_admin") {
    // Allow org admins to preview/download the template for courses in their organization.
    if (!caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    const { data: courseRow } = await admin.from("courses").select("id, organization_id").eq("id", id).maybeSingle();
    const courseOrgId = courseRow && typeof (courseRow as { organization_id?: unknown }).organization_id === "string"
      ? String((courseRow as { organization_id: string }).organization_id)
      : null;
    if (!courseOrgId || courseOrgId !== caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  } else if (!["super_admin", "system_admin"].includes(caller.role)) {
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const [{ data: tpl, error: tplError }, { data: settings, error: settingsError }] = await Promise.all([
    admin
      .from("course_certificate_templates")
      .select("storage_bucket, storage_path, file_name, mime_type")
      .eq("course_id", id)
      .maybeSingle(),
    preview
      ? admin.from("course_certificate_settings").select("name_placement_json, certificate_title").eq("course_id", id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (tplError) return apiError("INTERNAL", "Failed to load certificate template.", { status: 500 });
  if (!tpl?.storage_bucket || !tpl?.storage_path) {
    return apiError("NOT_FOUND", "Certificate template not found.", { status: 404 });
  }

  if (preview) {
    if (settingsError) return apiError("INTERNAL", "Failed to load certificate settings.", { status: 500 });
    const placementRaw = (settings as { name_placement_json?: unknown } | null)?.name_placement_json;
    const placement = (placementRaw && typeof placementRaw === "object" ? (placementRaw as Placement) : null) as Placement | null;
    if (!placement || !Number.isFinite(Number(placement.page))) {
      return apiError("CONFLICT", "Certificate name placement is not configured yet.", { status: 409 });
    }

    // Download template bytes (no redirect): we render a PDF preview with the placement applied.
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
      return apiError("VALIDATION_ERROR", "Unsupported template image type for preview. Please upload PDF, PNG, or JPG.", { status: 400 });
    }

    const pages = pdfDoc.getPages();
    const pageIndex = Math.max(0, Math.min(pages.length - 1, Math.floor(Number(placement.page) - 1)));
    const targetPage = pages[pageIndex];
    const pageW = targetPage.getWidth();
    const pageH = targetPage.getHeight();

    const font = await pdfDoc.embedFont(pickStandardFontName(placement.fontFamily));
    const desiredFontSize = Number.isFinite(Number(placement.fontSize)) ? Math.max(6, Math.min(200, Number(placement.fontSize))) : 32;
    const maxTextWidth = placement.wPct !== undefined ? clamp01(Number(placement.wPct)) * pageW : null;
    const fontSize = fitFontSizeToWidth({ font, text: PREVIEW_NAME, desired: desiredFontSize, maxWidth: maxTextWidth });

    const align = placement.align === "left" || placement.align === "right" || placement.align === "center" ? placement.align : "center";
    const color = parseHexColor(placement.color) ?? { r: 0.07, g: 0.07, b: 0.07 };

    const xPct = clamp01(Number(placement.xPct));
    const yPct = clamp01(Number(placement.yPct));

    const textWidth = font.widthOfTextAtSize(PREVIEW_NAME, fontSize);
    const xCenter = xPct * pageW;
    const x = align === "center" ? xCenter - textWidth / 2 : align === "right" ? xCenter - textWidth : xCenter;

    // placement.yPct is from TOP (as set in the UI). PDF origin is bottom-left.
    const yFromTop = yPct * pageH;
    const y = Math.max(0, pageH - yFromTop - fontSize / 2);

    targetPage.drawText(PREVIEW_NAME, {
      x: Math.max(0, Math.min(pageW - 1, x)),
      y: Math.max(0, Math.min(pageH - 1, y)),
      size: fontSize,
      font,
      color: rgb(color.r, color.g, color.b),
    });

    const outBytes = await pdfDoc.save();
    const fileName = "certificate-preview.pdf";
    return new NextResponse(Buffer.from(outBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const { data: signed, error: signedError } = await admin.storage
    .from(tpl.storage_bucket)
    .createSignedUrl(tpl.storage_path, 60 * 10);

  if (signedError || !signed?.signedUrl) {
    return apiError("INTERNAL", "Failed to create signed URL.", { status: 500 });
  }

  return NextResponse.redirect(signed.signedUrl, { status: 302 });
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

  if (caller.role !== "organization_admin") {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return apiError("VALIDATION_ERROR", "Invalid form data.", { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File)) return apiError("VALIDATION_ERROR", "Missing file.", { status: 400 });

  const allowed = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(file.type)) {
    return apiError("VALIDATION_ERROR", "Invalid file type (allowed: PDF, PNG, JPG, WebP).", { status: 400 });
  }

  const maxBytes = 10 * 1024 * 1024;
  if (file.size > maxBytes) return apiError("VALIDATION_ERROR", "File too large (max 10MB).", { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: courseRow, error: courseError } = await admin
    .from("courses")
    .select("id, organization_id")
    .eq("id", id)
    .single();

  if (courseError || !courseRow) {
    return apiError("NOT_FOUND", "Course not found.", { status: 404 });
  }

  if (!caller.organization_id || courseRow.organization_id !== caller.organization_id) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  // If an old template exists, remove best-effort after upload succeeds.
  const { data: existing } = await admin
    .from("course_certificate_templates")
    .select("id, storage_bucket, storage_path")
    .eq("course_id", id)
    .maybeSingle();

  const bucket = "certificate-templates";
  const ext = getExtFromMime(file.type);
  const ts = Date.now();
  const path = `courses/${id}/template-${ts}.${ext}`;

  const bytes = await file.arrayBuffer();
  const uploadRes = await admin.storage.from(bucket).upload(path, bytes, {
    contentType: file.type,
    upsert: true,
  });

  if (uploadRes.error) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Upload failed.", internalMessage: uploadRes.error.message });
    return apiError("INTERNAL", "Upload failed.", { status: 500 });
  }

  const { data: upserted, error: upsertError } = await admin
    .from("course_certificate_templates")
    .upsert(
      {
        course_id: id,
        organization_id: courseRow.organization_id,
        storage_bucket: bucket,
        storage_path: path,
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
        uploaded_by: caller.id,
      },
      { onConflict: "course_id" }
    )
    .select("id, created_at, course_id, storage_bucket, storage_path, file_name, mime_type, size_bytes")
    .single();

  if (upsertError || !upserted) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to save certificate template.", internalMessage: upsertError?.message });
    return apiError("INTERNAL", "Failed to save certificate template.", { status: 500 });
  }

  if (existing?.storage_bucket && existing?.storage_path) {
    try {
      await admin.storage.from(existing.storage_bucket).remove([existing.storage_path]);
    } catch {
      // ignore
    }
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "upload_certificate_template",
      entity: "courses",
      entity_id: id,
      metadata: { path, file_name: file.name },
    });
  } catch {
    // ignore
  }

  await logApiEvent({ request, caller, outcome: "success", status: 201, publicMessage: "Certificate template uploaded.", details: { course_id: id } });
  return apiOk({ template: upserted }, { status: 201, message: "Certificate template uploaded." });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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

  if (caller.role !== "organization_admin") {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data: row, error: loadError } = await admin
    .from("course_certificate_templates")
    .select("id, organization_id, storage_bucket, storage_path")
    .eq("course_id", id)
    .maybeSingle();

  if (loadError) return apiError("INTERNAL", "Failed to load certificate template.", { status: 500 });
  if (!row) return apiOk({ ok: true }, { status: 200 });

  if (!caller.organization_id || row.organization_id !== caller.organization_id) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const { error: delError } = await admin.from("course_certificate_templates").delete().eq("course_id", id);
  if (delError) {
    await logApiEvent({ request, caller, outcome: "error", status: 500, code: "INTERNAL", publicMessage: "Failed to delete certificate template.", internalMessage: delError.message });
    return apiError("INTERNAL", "Failed to delete certificate template.", { status: 500 });
  }

  try {
    await admin.storage.from(row.storage_bucket).remove([row.storage_path]);
  } catch {
    // ignore
  }

  await logApiEvent({ request, caller, outcome: "success", status: 200, publicMessage: "Certificate template deleted.", details: { course_id: id } });
  return apiOk({ ok: true }, { status: 200, message: "Certificate template deleted." });
}

