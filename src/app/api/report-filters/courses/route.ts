import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

export const runtime = "nodejs";

function parseIntParam(v: string | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

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
  if (!["super_admin", "system_admin", "organization_admin"].includes(caller.role)) {
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const requestedOrgId = url.searchParams.get("organization_id");
  const page = parseIntParam(url.searchParams.get("page"), 1);
  const pageSize = Math.min(parseIntParam(url.searchParams.get("page_size"), 20), 50);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const admin = createAdminSupabaseClient();

  // Org-only courses:
  // - org admins: only their org-owned courses (draft + archived included)
  // - super/system: all courses (for reporting)
  let orgId: string | null = requestedOrgId;

  if (caller.role === "organization_admin") {
    if (!caller.organization_id) return apiError("VALIDATION_ERROR", "Missing organization.", { status: 400 });
    orgId = caller.organization_id;
  }

  let query = admin
    .from("courses")
    .select("id, title, is_published, is_archived, organization_id, visibility_scope, updated_at", { count: "exact" })
    .order("updated_at", { ascending: false })
    .range(from, to);

  if (caller.role === "organization_admin") {
    query = query.eq("organization_id", orgId);
  } else if (orgId) {
    // For system/super: optional org filter can help narrow results
    query = query.eq("organization_id", orgId);
  }

  if (q.length > 0) {
    const s = q.replace(/,+/g, " ").slice(0, 120);
    query = query.ilike("title", `%${s}%`);
  }

  const { data, error: loadError, count } = await query;
  if (loadError) return apiError("INTERNAL", "Failed to load courses.", { status: 500 });

  const courses = Array.isArray(data)
    ? (data as Array<{
        id: string;
        title?: string | null;
        is_published?: boolean | null;
        is_archived?: boolean | null;
        organization_id?: string | null;
        visibility_scope?: string | null;
      }>)
    : [];

  return apiOk(
    {
      courses,
      items: courses.map((c) => {
        // Never expose IDs in the UI label.
        const title = (c.title ?? "").trim() || "Untitled course";
        const archived = c.is_archived === true;
        const published = c.is_published === true;
        const status = archived ? "Archived" : (published ? "Published" : "Draft");
        return { id: c.id, label: title, meta: `${status}` };
      }),
      page,
      page_size: pageSize,
      total: typeof count === "number" ? count : 0,
    },
    { status: 200 }
  );
}

