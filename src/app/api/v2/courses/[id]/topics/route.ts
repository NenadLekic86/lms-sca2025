import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { createTopicSchema, validateSchema } from "@/lib/validations/schemas";

async function assertCourseOwner(courseId: string, callerOrgId: string) {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from("courses").select("id, organization_id").eq("id", courseId).single();
  if (error || !data?.id) return { ok: false as const, status: 404 as const, message: "Course not found." };
  if (data.organization_id !== callerOrgId) return { ok: false as const, status: 403 as const, message: "Forbidden" };
  return { ok: true as const, admin, orgId: data.organization_id as string };
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const own = await assertCourseOwner(id, caller.organization_id);
  if (!own.ok) return apiError(own.status === 404 ? "NOT_FOUND" : "FORBIDDEN", own.message, { status: own.status });

  const { data, error: queryError } = await own.admin
    .from("course_topics")
    .select("id, title, summary, position, created_at, updated_at")
    .eq("course_id", id)
    .order("position", { ascending: true });
  if (queryError) return apiError("INTERNAL", "Failed to load topics.", { status: 500 });
  return apiOk({ topics: Array.isArray(data) ? data : [] }, { status: 200 });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  if (caller.role !== "organization_admin" || !caller.organization_id) return apiError("FORBIDDEN", "Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = validateSchema(createTopicSchema, body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", parsed.error, { status: 400 });

  const own = await assertCourseOwner(id, caller.organization_id);
  if (!own.ok) return apiError(own.status === 404 ? "NOT_FOUND" : "FORBIDDEN", own.message, { status: own.status });

  const { count, error: countError } = await own.admin
    .from("course_topics")
    .select("id", { count: "exact", head: true })
    .eq("course_id", id);
  if (countError) return apiError("INTERNAL", "Failed to create topic.", { status: 500 });

  const { data, error: insertError } = await own.admin
    .from("course_topics")
    .insert({
      course_id: id,
      organization_id: own.orgId,
      title: parsed.data.title.trim(),
      summary: parsed.data.summary?.trim() || null,
      position: count ?? 0,
      created_by: caller.id,
      updated_by: caller.id,
    })
    .select("id, title, summary, position, created_at, updated_at")
    .single();

  if (insertError || !data) return apiError("INTERNAL", "Failed to create topic.", { status: 500 });
  return apiOk({ topic: data }, { status: 201, message: "Topic created." });
}

