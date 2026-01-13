import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

function isPdf(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function sanitizeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 140);
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Use session client so RLS applies (members will only see enrolled resources).
  const supabase = await createServerSupabaseClient();
  const { data, error: loadError } = await supabase
    .from("course_resources")
    .select("id, created_at, course_id, title, file_name, storage_bucket, storage_path, mime_type, size_bytes")
    .eq("course_id", id)
    .order("created_at", { ascending: false });

  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
  return NextResponse.json({ resources: Array.isArray(data) ? data : [] }, { status: 200 });
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

  const files = [
    ...form.getAll("files"),
    ...form.getAll("file"),
  ].filter((v): v is File => v instanceof File);

  if (files.length === 0) return NextResponse.json({ error: "Missing file(s)" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: courseRow, error: courseError } = await admin
    .from("courses")
    .select("id, organization_id")
    .eq("id", id)
    .single();

  if (courseError || !courseRow) {
    return NextResponse.json({ error: courseError?.message || "Course not found" }, { status: 404 });
  }

  // Org admins can only manage org-owned courses
  if (caller.role === "organization_admin") {
    if (!caller.organization_id || courseRow.organization_id !== caller.organization_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const bucket = "course-resources";
  const maxBytes = 20 * 1024 * 1024; // 20MB cap (matches SQL constraint suggestion)

  const insertedRows: unknown[] = [];
  for (const file of files) {
    if (!isPdf(file)) {
      return NextResponse.json({ error: "Only PDF files are allowed" }, { status: 400 });
    }
    if (file.size > maxBytes) {
      return NextResponse.json({ error: "File too large (max 20MB)" }, { status: 400 });
    }

    const ts = Date.now();
    const safeName = sanitizeFileName(file.name || "resource.pdf");
    const path = `courses/${id}/resources/${ts}-${safeName}`;

    const bytes = await file.arrayBuffer();
    const uploadRes = await admin.storage.from(bucket).upload(path, bytes, {
      contentType: "application/pdf",
      upsert: true,
    });

    if (uploadRes.error) {
      return NextResponse.json({ error: uploadRes.error.message }, { status: 500 });
    }

    const { data: inserted, error: insertError } = await admin
      .from("course_resources")
      .insert({
        course_id: id,
        organization_id: courseRow.organization_id,
        title: null,
        file_name: file.name,
        storage_bucket: bucket,
        storage_path: path,
        mime_type: "application/pdf",
        size_bytes: file.size,
        uploaded_by: caller.id,
      })
      .select("id, created_at, title, file_name, storage_bucket, storage_path, mime_type, size_bytes")
      .single();

    if (insertError || !inserted) {
      return NextResponse.json({ error: insertError?.message || "Failed to save resource" }, { status: 500 });
    }

    // Best-effort audit log
    try {
      await admin.from("audit_logs").insert({
        actor_user_id: caller.id,
        actor_email: caller.email,
        actor_role: caller.role,
        action: "upload_course_resource",
        entity: "courses",
        entity_id: id,
        metadata: { path, file_name: file.name },
      });
    } catch {
      // ignore
    }

    insertedRows.push(inserted);
  }

  return NextResponse.json({ resources: insertedRows }, { status: 201 });
}

