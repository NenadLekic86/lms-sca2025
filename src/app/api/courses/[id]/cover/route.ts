import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

function getExtFromMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "bin";
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!["super_admin", "system_admin", "organization_admin"].includes(caller.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Invalid form data" }, { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(file.type)) {
    return NextResponse.json({ error: "Invalid file type (allowed: PNG, JPG, WebP)" }, { status: 400 });
  }

  const maxBytes = 5 * 1024 * 1024; // 5MB
  if (file.size > maxBytes) {
    return NextResponse.json({ error: "File too large (max 5MB)" }, { status: 400 });
  }

  // Use service role for Storage upload and course update.
  const admin = createAdminSupabaseClient();

  // Ensure caller is allowed to edit this course.
  // - super/system: can edit any
  // - org admin: only courses owned by their org
  if (caller.role === "organization_admin") {
    const { data: row, error: rowError } = await admin
      .from("courses")
      .select("organization_id")
      .eq("id", id)
      .single();
    if (rowError || !row) {
      return NextResponse.json({ error: rowError?.message || "Course not found" }, { status: 404 });
    }
    if (!caller.organization_id || row.organization_id !== caller.organization_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const ext = getExtFromMime(file.type);
  const ts = Date.now();
  const path = `courses/${id}/cover-${ts}.${ext}`;

  const bytes = await file.arrayBuffer();
  const uploadRes = await admin.storage.from("course-covers").upload(path, bytes, {
    contentType: file.type,
    upsert: true,
  });

  if (uploadRes.error) {
    return NextResponse.json({ error: uploadRes.error.message }, { status: 500 });
  }

  const { data: publicUrlData } = admin.storage.from("course-covers").getPublicUrl(path);
  const coverUrl = publicUrlData.publicUrl;

  const { error: updateError } = await admin
    .from("courses")
    .update({ cover_image_url: coverUrl, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "upload_course_cover",
      entity: "courses",
      entity_id: id,
      metadata: { path },
    });
  } catch {
    // ignore
  }

  return NextResponse.json({ cover_image_url: coverUrl });
}

