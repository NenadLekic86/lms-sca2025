import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string; videoId: string }> }) {
  const { id, videoId } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!["super_admin", "system_admin", "organization_admin"].includes(caller.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  const { data: videoRow, error: loadError } = await admin
    .from("course_videos")
    .select("id, course_id, organization_id")
    .eq("id", videoId)
    .eq("course_id", id)
    .single();

  if (loadError || !videoRow) {
    return NextResponse.json({ error: loadError?.message || "Video not found" }, { status: 404 });
  }

  if (caller.role === "organization_admin") {
    if (!caller.organization_id || videoRow.organization_id !== caller.organization_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const { error: delError } = await admin.from("course_videos").delete().eq("id", videoId);
  if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "remove_course_video",
      entity: "courses",
      entity_id: id,
      metadata: { video_id: videoId },
    });
  } catch {
    // ignore
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

