import { NextRequest } from "next/server";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

type AssignableCourseRow = {
  id: string;
  title: string | null;
  is_published: boolean | null;
  is_archived: boolean | null;
  created_at: string | null;
};

export async function GET(request: NextRequest) {
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
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 403,
      code: "FORBIDDEN",
      publicMessage: "Forbidden",
    });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  if (!caller.organization_id) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 400,
      code: "VALIDATION_ERROR",
      publicMessage: "Missing organization.",
    });
    return apiError("VALIDATION_ERROR", "Missing organization.", { status: 400 });
  }

  const supabase = await createServerSupabaseClient();
  const { data, error: queryError } = await supabase
    .from("courses")
    .select("id, title, is_published, is_archived, created_at")
    .eq("organization_id", caller.organization_id)
    .eq("visibility_scope", "organizations")
    .eq("is_archived", false)
    .order("created_at", { ascending: false });

  if (queryError) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to load courses.",
      internalMessage: queryError.message,
    });
    return apiError("INTERNAL", "Failed to load courses.", { status: 500 });
  }

  const courses = (Array.isArray(data) ? data : []) as AssignableCourseRow[];
  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Assignable courses loaded.",
    details: { count: courses.length },
  });

  return apiOk({ courses }, { status: 200 });
}

