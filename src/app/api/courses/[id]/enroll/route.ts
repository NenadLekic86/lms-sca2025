import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (caller.role !== "member") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const session = await createServerSupabaseClient();
  const admin = createAdminSupabaseClient();

  // Derive org id the same way your RLS policies do (often via `current_user_org()`).
  const { data: orgIdRaw } = await session.rpc("current_user_org");
  const orgId = typeof orgIdRaw === "string" ? orgIdRaw : caller.organization_id;
  if (!orgId) {
    return NextResponse.json({ error: "Missing organization" }, { status: 400 });
  }

  const { data: course, error: courseError } = await admin
    .from("courses")
    .select("id, organization_id, is_published, visibility_scope")
    .eq("id", id)
    .maybeSingle();

  if (courseError) {
    return NextResponse.json({ error: courseError.message }, { status: 400 });
  }
  if (!course?.id) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  if (!course.is_published) {
    return NextResponse.json({ error: "Course is not published" }, { status: 403 });
  }

  // Match DB policy visibility logic:
  // allow if:
  // - visibility_scope = 'all', OR
  // - course.organization_id = current_user_org(), OR
  // - course is assigned to current_user_org() via course_organizations
  const isGlobal = course.visibility_scope === "all";
  const isOrgOwned = course.organization_id === orgId;
  let isAssigned = false;

  if (!isGlobal && !isOrgOwned) {
    const { data: link, error: linkError } = await admin
      .from("course_organizations")
      .select("course_id")
      .eq("course_id", id)
      .eq("organization_id", orgId)
      .maybeSingle();

    if (linkError) {
      return NextResponse.json({ error: linkError.message }, { status: 400 });
    }

    isAssigned = Boolean(link);
  }

  if (!isGlobal && !isOrgOwned && !isAssigned) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Already enrolled? (idempotent)
  const { data: existing } = await session
    .from("course_enrollments")
    .select("id, status, enrolled_at")
    .eq("course_id", id)
    .eq("user_id", caller.id)
    .maybeSingle();

  if (existing?.id) {
    return NextResponse.json({ ok: true, enrollment: existing }, { status: 200 });
  }

  // Insert with the MEMBER session so RLS is enforced by `enrollments_member_insert_self`.
  const { data: inserted, error: insError } = await session
    .from("course_enrollments")
    .insert({
      organization_id: orgId,
      course_id: id,
      user_id: caller.id,
      status: "active",
    })
    .select("id, status, enrolled_at")
    .single();

  if (insError || !inserted) {
    // Unique constraint race or already enrolled → treat as ok.
    if ((insError as { code?: string } | null)?.code === "23505") {
      const { data: row } = await session
        .from("course_enrollments")
        .select("id, status, enrolled_at")
        .eq("course_id", id)
        .eq("user_id", caller.id)
        .maybeSingle();
      if (row?.id) return NextResponse.json({ ok: true, enrollment: row }, { status: 200 });
    }

    return NextResponse.json({ error: insError?.message || "Failed to enroll" }, { status: 400 });
  }

  return NextResponse.json({ ok: true, enrollment: inserted }, { status: 201 });
}

