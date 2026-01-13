import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string; resourceId: string }> }) {
  const { id, resourceId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!["super_admin", "system_admin", "organization_admin"].includes(caller.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  const { data: resourceRow, error: loadError } = await admin
    .from("course_resources")
    .select("id, course_id, organization_id, storage_bucket, storage_path")
    .eq("id", resourceId)
    .eq("course_id", id)
    .single();

  if (loadError || !resourceRow) {
    return NextResponse.json({ error: loadError?.message || "Resource not found" }, { status: 404 });
  }

  if (caller.role === "organization_admin") {
    if (!caller.organization_id || resourceRow.organization_id !== caller.organization_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const { error: delError } = await admin.from("course_resources").delete().eq("id", resourceId);
  if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });

  // Best-effort Storage cleanup
  try {
    await admin.storage.from(resourceRow.storage_bucket).remove([resourceRow.storage_path]);
  } catch {
    // ignore
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "remove_course_resource",
      entity: "courses",
      entity_id: id,
      metadata: { resource_id: resourceId, path: resourceRow.storage_path },
    });
  } catch {
    // ignore
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

