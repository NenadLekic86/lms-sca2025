import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { createCourseSchema, validateSchema } from "@/lib/validations/schemas";

type CreatedCourse = { id: string };

export async function POST(request: NextRequest) {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!["super_admin", "system_admin", "organization_admin"].includes(caller.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const validation = validateSchema(createCourseSchema, body);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { title, description, excerpt, visibility_scope, organization_ids } = validation.data;

  const supabase = await createServerSupabaseClient();

  // org_admin can only create org-owned courses (never global / never selected-org catalog)
  const isOrgAdmin = caller.role === "organization_admin";
  const isSuperSystem = caller.role === "super_admin" || caller.role === "system_admin";

  const now = new Date().toISOString();

  let insertPayload: Record<string, unknown> = {
    title,
    description,
    excerpt,
    created_by: caller.id,
    is_published: false,
    created_at: now,
    updated_at: now,
  };

  if (isOrgAdmin) {
    if (!caller.organization_id) {
      return NextResponse.json({ error: "Forbidden: org admin missing organization" }, { status: 403 });
    }
    insertPayload = {
      ...insertPayload,
      organization_id: caller.organization_id,
      visibility_scope: "organizations",
    };
  } else if (isSuperSystem) {
    if (visibility_scope === "all") {
      insertPayload = {
        ...insertPayload,
        organization_id: null,
        visibility_scope: "all",
      };
    } else {
      insertPayload = {
        ...insertPayload,
        organization_id: null,
        visibility_scope: "organizations",
      };
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from("courses")
    .insert(insertPayload)
    .select("id")
    .single();

  if (insertError || !inserted) {
    return NextResponse.json({ error: insertError?.message || "Failed to create course" }, { status: 500 });
  }

  const created = inserted as CreatedCourse;

  // For super/system: if visibility is "organizations", insert selected org visibility rows
  if (isSuperSystem && visibility_scope === "organizations") {
    const orgIds = Array.isArray(organization_ids) ? organization_ids : [];

    if (orgIds.length > 0) {
      const rows = orgIds.map((orgId) => ({ course_id: created.id, organization_id: orgId }));
      const { error: linkError } = await supabase.from("course_organizations").insert(rows);
      if (linkError) {
        // Best-effort rollback: keep the course (still manageable by admins); surface a clear error.
        return NextResponse.json(
          { error: `Course created but org visibility failed: ${linkError.message}`, course_id: created.id },
          { status: 500 }
        );
      }
    }
  }

  // Best-effort audit log
  try {
    await supabase.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "create_course",
      entity: "courses",
      entity_id: created.id,
      metadata: {
        visibility_scope: isOrgAdmin ? "organizations" : visibility_scope,
        organization_ids: isOrgAdmin ? [caller.organization_id] : (organization_ids ?? []),
      },
    });
  } catch {
    // ignore
  }

  return NextResponse.json({ course_id: created.id }, { status: 201 });
}

