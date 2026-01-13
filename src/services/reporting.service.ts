import { createAdminSupabaseClient } from "@/lib/supabase/server";

export type CourseResult = "passed" | "failed" | "not_submitted";
export type CourseResultFilter = CourseResult | "all";

export type EnrollmentTestSummaryRow = {
  organization_id: string;
  organization_name: string | null;

  user_id: string;
  user_email: string | null;
  user_full_name: string | null;

  course_id: string;
  course_title: string | null;

  enrollment_status: string | null;
  enrolled_at: string | null;

  test_id: string | null;
  test_title: string | null;

  attempt_count: number | null;
  submitted_count: number | null;
  total_duration_seconds: number | null;

  latest_attempt_number: number | null;
  latest_started_at: string | null;
  latest_submitted_at: string | null;
  latest_score: number | null;
  latest_passed: boolean | null;
  latest_attempt_duration_seconds: number | null;

  course_result: CourseResult | null;
};

export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatCourseResult(result: CourseResult | null | undefined): { label: string; cls: string } {
  switch (result) {
    case "passed":
      return { label: "Passed", cls: "bg-green-100 text-green-800" };
    case "failed":
      return { label: "Failed", cls: "bg-red-100 text-red-800" };
    case "not_submitted":
    default:
      return { label: "Not Submitted", cls: "bg-gray-100 text-gray-800" };
  }
}

export type EnrollmentSummaryFilters = {
  organizationId?: string;
  courseId?: string;
  userId?: string;
  result?: CourseResultFilter;
  q?: string; // search user_email/user_full_name/course_title
  from?: string; // ISO string
  to?: string; // ISO string
  limit?: number; // for exports only
};

function sanitizeSearchQuery(q: string): string {
  return q.trim().replace(/,+/g, " ").slice(0, 120);
}

function humanizeSlug(slug: string): string {
  const s = slug
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  if (!s) return "";
  return s
    .split(" ")
    .map((p) => (p.length > 0 ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

function normalizeDateInput(value: string, kind: "from" | "to"): string {
  const v = value.trim();
  // Accept YYYY-MM-DD and convert to UTC day bounds.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return kind === "from" ? `${v}T00:00:00.000Z` : `${v}T23:59:59.999Z`;
  }
  return v;
}

export async function fetchEnrollmentTestSummary(
  params: EnrollmentSummaryFilters
): Promise<{ rows: EnrollmentTestSummaryRow[]; error: string | null }> {
  const admin = createAdminSupabaseClient();
  const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 50000) : 5000;

  let q = admin
    .from("report_enrollment_test_summary")
    .select(
      [
        "organization_id",
        "organization_name",
        "user_id",
        "user_email",
        "user_full_name",
        "course_id",
        "course_title",
        "enrollment_status",
        "enrolled_at",
        "test_id",
        "test_title",
        "attempt_count",
        "submitted_count",
        "total_duration_seconds",
        "latest_attempt_number",
        "latest_started_at",
        "latest_submitted_at",
        "latest_score",
        "latest_passed",
        "latest_attempt_duration_seconds",
        "course_result",
      ].join(",")
    )
    .order("enrolled_at", { ascending: false })
    .limit(limit);

  if (params.organizationId) {
    q = q.eq("organization_id", params.organizationId);
  }
  if (params.courseId) {
    q = q.eq("course_id", params.courseId);
  }
  if (params.userId) {
    q = q.eq("user_id", params.userId);
  }
  if (params.result && params.result !== "all") {
    q = q.eq("course_result", params.result);
  }
  if (params.from) {
    q = q.gte("enrolled_at", normalizeDateInput(params.from, "from"));
  }
  if (params.to) {
    q = q.lte("enrolled_at", normalizeDateInput(params.to, "to"));
  }
  if (params.q && params.q.trim().length > 0) {
    const s = sanitizeSearchQuery(params.q);
    // PostgREST OR filter (comma-separated clauses). Keep query safe by removing commas above.
    q = q.or(`user_email.ilike.%${s}%,user_full_name.ilike.%${s}%,course_title.ilike.%${s}%`);
  }

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (Array.isArray(data) ? (data as unknown as EnrollmentTestSummaryRow[]) : []), error: null };
}

export type EnrollmentDailyPoint = { day: string; count: number };

export async function fetchEnrollmentsDaily(params: {
  organizationId?: string;
  days?: number; // used only when from/to not provided
  from?: string; // ISO
  to?: string; // ISO
}): Promise<{ points: EnrollmentDailyPoint[]; error: string | null }> {
  const admin = createAdminSupabaseClient();

  const days = typeof params.days === "number" && params.days > 0 ? Math.min(params.days, 90) : 14;
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - (days - 1));
  defaultFrom.setUTCHours(0, 0, 0, 0);

  const fromIso = params.from ? normalizeDateInput(params.from, "from") : defaultFrom.toISOString();
  const toIso = params.to ? normalizeDateInput(params.to, "to") : new Date(now).toISOString();

  let q = admin
    .from("course_enrollments")
    .select("enrolled_at")
    .gte("enrolled_at", fromIso)
    .lte("enrolled_at", toIso)
    .limit(10000);

  if (params.organizationId) q = q.eq("organization_id", params.organizationId);

  const { data, error } = await q;
  if (error) return { points: [], error: error.message };

  const counts: Record<string, number> = {};
  for (const row of (Array.isArray(data) ? data : []) as Array<{ enrolled_at?: string | null }>) {
    const iso = typeof row.enrolled_at === "string" ? row.enrolled_at : null;
    if (!iso) continue;
    const day = iso.slice(0, 10);
    counts[day] = (counts[day] || 0) + 1;
  }

  // Fill missing days in range
  const points: EnrollmentDailyPoint[] = [];
  const start = new Date(fromIso);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(toIso);
  end.setUTCHours(0, 0, 0, 0);

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    points.push({ day, count: counts[day] || 0 });
  }

  return { points, error: null };
}

export type TopBucket = { id: string; label: string; count: number };

export function topCoursesFromSummary(rows: EnrollmentTestSummaryRow[], limit = 5): TopBucket[] {
  const by: Record<string, { label: string; count: number }> = {};
  for (const r of rows) {
    const id = r.course_id;
    const label = (r.course_title ?? "").trim() || "Untitled course";
    by[id] = by[id] || { label, count: 0 };
    by[id].count += 1;
  }
  return Object.entries(by)
    .map(([id, v]) => ({ id, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit));
}

export function topUsersFromSummary(rows: EnrollmentTestSummaryRow[], limit = 5): TopBucket[] {
  const by: Record<string, { label: string; count: number }> = {};
  for (const r of rows) {
    const id = r.user_id;
    const label =
      (r.user_full_name && r.user_full_name.trim().length > 0 ? r.user_full_name.trim() : null) ??
      (r.user_email && r.user_email.trim().length > 0 ? r.user_email.trim() : null) ??
      "Unknown user";
    by[id] = by[id] || { label, count: 0 };
    // "Top users" metric: count of passed enrollments
    if (r.course_result === "passed") by[id].count += 1;
  }
  return Object.entries(by)
    .map(([id, v]) => ({ id, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit));
}

export async function fetchEnrollmentTestSummaryPage(params: EnrollmentSummaryFilters & { page: number; pageSize: number }): Promise<{
  rows: EnrollmentTestSummaryRow[];
  count: number;
  page: number;
  pageSize: number;
  totalPages: number;
  error: string | null;
}> {
  const admin = createAdminSupabaseClient();
  const pageSize = Number.isFinite(params.pageSize) && params.pageSize > 0 ? Math.min(params.pageSize, 100) : 20;
  const page = Number.isFinite(params.page) && params.page > 0 ? Math.floor(params.page) : 1;

  const fromIdx = (page - 1) * pageSize;
  const toIdx = fromIdx + pageSize - 1;

  let q = admin
    .from("report_enrollment_test_summary")
    .select(
      [
        "organization_id",
        "organization_name",
        "user_id",
        "user_email",
        "user_full_name",
        "course_id",
        "course_title",
        "enrollment_status",
        "enrolled_at",
        "test_id",
        "test_title",
        "attempt_count",
        "submitted_count",
        "total_duration_seconds",
        "latest_attempt_number",
        "latest_started_at",
        "latest_submitted_at",
        "latest_score",
        "latest_passed",
        "latest_attempt_duration_seconds",
        "course_result",
      ].join(","),
      { count: "exact" }
    )
    .order("enrolled_at", { ascending: false })
    .range(fromIdx, toIdx);

  if (params.organizationId) q = q.eq("organization_id", params.organizationId);
  if (params.courseId) q = q.eq("course_id", params.courseId);
  if (params.userId) q = q.eq("user_id", params.userId);
  if (params.result && params.result !== "all") q = q.eq("course_result", params.result);
  if (params.from) q = q.gte("enrolled_at", normalizeDateInput(params.from, "from"));
  if (params.to) q = q.lte("enrolled_at", normalizeDateInput(params.to, "to"));
  if (params.q && params.q.trim().length > 0) {
    const s = sanitizeSearchQuery(params.q);
    q = q.or(`user_email.ilike.%${s}%,user_full_name.ilike.%${s}%,course_title.ilike.%${s}%`);
  }

  const { data, error, count } = await q;
  if (error) {
    return { rows: [], count: 0, page, pageSize, totalPages: 0, error: error.message };
  }

  const total = typeof count === "number" ? count : 0;
  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;

  const rows = (Array.isArray(data) ? (data as unknown as EnrollmentTestSummaryRow[]) : []);

  // Hydrate display fields (names/titles) for UI rendering without exposing IDs.
  // This also guards against views that may return slugs instead of human-friendly names.
  try {
    const orgIds = Array.from(new Set(rows.map((r) => r.organization_id).filter((v) => typeof v === "string" && v.length > 0)));
    const courseIds = Array.from(new Set(rows.map((r) => r.course_id).filter((v) => typeof v === "string" && v.length > 0)));
    const userIds = Array.from(new Set(rows.map((r) => r.user_id).filter((v) => typeof v === "string" && v.length > 0)));

    const [orgRes, courseRes, userRes] = await Promise.all([
      orgIds.length > 0
        ? admin.from("organizations").select("id, name, slug").in("id", orgIds)
        : Promise.resolve({ data: [], error: null } as unknown as { data: unknown[]; error: { message: string } | null }),
      courseIds.length > 0
        ? admin.from("courses").select("id, title").in("id", courseIds)
        : Promise.resolve({ data: [], error: null } as unknown as { data: unknown[]; error: { message: string } | null }),
      userIds.length > 0
        ? admin.from("users").select("id, full_name, email").in("id", userIds)
        : Promise.resolve({ data: [], error: null } as unknown as { data: unknown[]; error: { message: string } | null }),
    ]);

    const orgMap: Record<string, string> = {};
    for (const o of (Array.isArray(orgRes.data) ? orgRes.data : []) as Array<{ id?: string; name?: string | null; slug?: string | null }>) {
      if (!o?.id) continue;
      const label =
        (o.name && o.name.trim().length > 0 ? o.name.trim() : null) ??
        (o.slug && o.slug.trim().length > 0 ? humanizeSlug(o.slug) : null) ??
        "Unnamed organization";
      orgMap[o.id] = label;
    }

    const courseMap: Record<string, string> = {};
    for (const c of (Array.isArray(courseRes.data) ? courseRes.data : []) as Array<{ id?: string; title?: string | null }>) {
      if (!c?.id) continue;
      courseMap[c.id] = (c.title ?? "").trim() || "Untitled course";
    }

    const userMap: Record<string, { full_name: string | null; email: string | null }> = {};
    for (const u of (Array.isArray(userRes.data) ? userRes.data : []) as Array<{ id?: string; full_name?: string | null; email?: string | null }>) {
      if (!u?.id) continue;
      userMap[u.id] = {
        full_name: typeof u.full_name === "string" ? u.full_name : null,
        email: typeof u.email === "string" ? u.email : null,
      };
    }

    for (const r of rows) {
      r.organization_name = orgMap[r.organization_id] ?? r.organization_name;
      r.course_title = courseMap[r.course_id] ?? r.course_title;
      const u = userMap[r.user_id];
      if (u) {
        r.user_full_name = (u.full_name ?? r.user_full_name) ?? null;
        r.user_email = (u.email ?? r.user_email) ?? null;
      }
    }
  } catch {
    // ignore hydration failures; view still provides baseline columns
  }

  return {
    rows,
    count: total,
    page,
    pageSize,
    totalPages,
    error: null,
  };
}

export async function fetchTopCourses(params: EnrollmentSummaryFilters & { limit?: number }): Promise<{ rows: TopBucket[]; error: string | null }> {
  const admin = createAdminSupabaseClient();
  const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 20) : 5;

  // NOTE:
  // PostgREST aggregate selects (e.g. count:course_id) can require GROUP BY and may error
  // depending on server configuration/view definition. To keep this reliable, we compute the
  // "top" lists in JS from a capped scan of rows (max 50k).
  const maxScan = 50000;
  let q = admin.from("report_enrollment_test_summary").select("course_id").limit(maxScan);

  if (params.organizationId) q = q.eq("organization_id", params.organizationId);
  if (params.courseId) q = q.eq("course_id", params.courseId);
  if (params.userId) q = q.eq("user_id", params.userId);
  if (params.result && params.result !== "all") q = q.eq("course_result", params.result);
  if (params.from) q = q.gte("enrolled_at", normalizeDateInput(params.from, "from"));
  if (params.to) q = q.lte("enrolled_at", normalizeDateInput(params.to, "to"));
  if (params.q && params.q.trim().length > 0) {
    const s = sanitizeSearchQuery(params.q);
    q = q.or(`user_email.ilike.%${s}%,user_full_name.ilike.%${s}%,course_title.ilike.%${s}%`);
  }

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };

  const rows = (Array.isArray(data) ? data : []) as Array<{ course_id?: unknown }>;
  const countsById: Record<string, number> = {};
  for (const r of rows) {
    const id = typeof r.course_id === "string" ? r.course_id : null;
    if (!id) continue;
    countsById[id] = (countsById[id] || 0) + 1;
  }

  const buckets = Object.entries(countsById)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit));

  const ids = buckets.map((b) => b.id);
  const titleById: Record<string, string> = {};
  if (ids.length > 0) {
    const { data: courses } = await admin.from("courses").select("id, title").in("id", ids);
    for (const c of (Array.isArray(courses) ? courses : []) as Array<{ id?: string; title?: string | null }>) {
      if (!c?.id) continue;
      titleById[c.id] = (c.title ?? "").trim() || "Untitled course";
    }
  }

  return { rows: buckets.map((b) => ({ id: b.id, label: titleById[b.id] ?? "Untitled course", count: b.count })), error: null };
}

export async function fetchTopUsersByPasses(
  params: EnrollmentSummaryFilters & { limit?: number }
): Promise<{ rows: TopBucket[]; error: string | null }> {
  const admin = createAdminSupabaseClient();
  const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 20) : 5;

  const maxScan = 50000;
  let q = admin
    .from("report_enrollment_test_summary")
    .select("user_id")
    .eq("course_result", "passed")
    .limit(maxScan);

  if (params.organizationId) q = q.eq("organization_id", params.organizationId);
  if (params.courseId) q = q.eq("course_id", params.courseId);
  if (params.userId) q = q.eq("user_id", params.userId);
  if (params.from) q = q.gte("enrolled_at", normalizeDateInput(params.from, "from"));
  if (params.to) q = q.lte("enrolled_at", normalizeDateInput(params.to, "to"));
  if (params.q && params.q.trim().length > 0) {
    const s = sanitizeSearchQuery(params.q);
    q = q.or(`user_email.ilike.%${s}%,user_full_name.ilike.%${s}%`);
  }

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };

  const rows = (Array.isArray(data) ? data : []) as Array<{ user_id?: unknown }>;
  const countsById: Record<string, number> = {};
  for (const r of rows) {
    const id = typeof r.user_id === "string" ? r.user_id : null;
    if (!id) continue;
    countsById[id] = (countsById[id] || 0) + 1;
  }

  const buckets = Object.entries(countsById)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit));

  const ids = buckets.map((b) => b.id);
  const labelById: Record<string, string> = {};
  if (ids.length > 0) {
    const { data: users } = await admin.from("users").select("id, full_name, email").in("id", ids);
    for (const u of (Array.isArray(users) ? users : []) as Array<{ id?: string; full_name?: string | null; email?: string | null }>) {
      if (!u?.id) continue;
      const fullName = (u.full_name ?? "").trim();
      const email = (u.email ?? "").trim();
      labelById[u.id] = (fullName.length > 0 ? fullName : (email.length > 0 ? email : "Unknown user"));
    }
  }

  return { rows: buckets.map((b) => ({ id: b.id, label: labelById[b.id] ?? "Unknown user", count: b.count })), error: null };
}

export async function fetchOrgReportStats(orgId: string): Promise<{
  usersCount: number;
  enrollmentsCount: number;
  passedCount: number;
  failedCount: number;
  pendingCount: number;
  completionRate: number;
  error: string | null;
}> {
  const admin = createAdminSupabaseClient();

  // Users count
  const usersRes = await admin.from("users").select("id", { count: "exact", head: true }).eq("organization_id", orgId);
  const usersCount = typeof usersRes.count === "number" ? usersRes.count : 0;

  // Enrollment summary from view (single fetch; used for pass/fail counts)
  const summary = await fetchEnrollmentTestSummary({ organizationId: orgId });
  if (usersRes.error) {
    return {
      usersCount,
      enrollmentsCount: 0,
      passedCount: 0,
      failedCount: 0,
      pendingCount: 0,
      completionRate: 0,
      error: usersRes.error.message,
    };
  }
  if (summary.error) {
    return {
      usersCount,
      enrollmentsCount: 0,
      passedCount: 0,
      failedCount: 0,
      pendingCount: 0,
      completionRate: 0,
      error: summary.error,
    };
  }

  const enrollmentsCount = summary.rows.length;
  const passedCount = summary.rows.filter((r) => r.course_result === "passed").length;
  const failedCount = summary.rows.filter((r) => r.course_result === "failed").length;
  const pendingCount = enrollmentsCount - passedCount - failedCount;
  const completionRate = enrollmentsCount > 0 ? Math.round((passedCount / enrollmentsCount) * 100) : 0;

  return { usersCount, enrollmentsCount, passedCount, failedCount, pendingCount, completionRate, error: null };
}

