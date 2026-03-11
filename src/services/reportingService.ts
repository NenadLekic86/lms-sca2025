import type { PostgrestError } from "@supabase/supabase-js";

import { createAdminSupabaseClient } from "@/lib/supabase/server";

export type EnrollmentResult = "certified" | "not_certified";
export type EnrollmentResultFilter = EnrollmentResult | "all";

export type EnrollmentSummaryRow = {
  organization_id: string;
  organization_name: string | null;

  user_id: string;
  user_email: string | null;
  user_full_name: string | null;

  course_id: string;
  course_title: string | null;

  enrollment_status: string | null;
  enrolled_at: string | null;

  certified: boolean;
  certificate_issued_at: string | null;
};

export function formatEnrollmentResult(r: EnrollmentSummaryRow): { label: string; cls: string } {
  return r.certified
    ? { label: "Certified", cls: "bg-green-100 text-green-800" }
    : { label: "Not certified", cls: "bg-gray-100 text-gray-800" };
}

export type EnrollmentSummaryFilters = {
  organizationId?: string;
  courseId?: string;
  userId?: string;
  result?: EnrollmentResultFilter;
  q?: string; // search user_email/user_full_name/course_title
  from?: string; // ISO string
  to?: string; // ISO string
  limit?: number; // for exports only
};

type QueryRes<T> = { data: T[] | null; error: PostgrestError | null };

type OrgRow = { id: string; name: string | null; slug: string | null };
type UserRow = { id: string; full_name: string | null; email: string | null };
type CourseRow = { id: string; title: string | null };
type CertRow = { user_id: string | null; course_id: string | null; issued_at: string | null; created_at: string | null };

function sanitizeSearchQuery(q: string): string {
  return q.trim().replace(/,+/g, " ").slice(0, 120);
}

function normalizeDateInput(value: string, kind: "from" | "to"): string {
  const v = value.trim();
  // Accept YYYY-MM-DD and convert to UTC day bounds.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return kind === "from" ? `${v}T00:00:00.000Z` : `${v}T23:59:59.999Z`;
  }
  return v;
}

export type TopBucket = { id: string; label: string; count: number };

async function hydrateEnrollmentRows(baseRows: Array<{
  organization_id?: string | null;
  user_id?: string | null;
  course_id?: string | null;
  status?: string | null;
  enrolled_at?: string | null;
}>): Promise<EnrollmentSummaryRow[]> {
  const admin = createAdminSupabaseClient();

  const orgIds = Array.from(new Set(baseRows.map((r) => r.organization_id).filter((v): v is string => typeof v === "string" && v.length > 0)));
  const userIds = Array.from(new Set(baseRows.map((r) => r.user_id).filter((v): v is string => typeof v === "string" && v.length > 0)));
  const courseIds = Array.from(new Set(baseRows.map((r) => r.course_id).filter((v): v is string => typeof v === "string" && v.length > 0)));

  const emptyOrgRes: QueryRes<OrgRow> = { data: [], error: null };
  const emptyUserRes: QueryRes<UserRow> = { data: [], error: null };
  const emptyCourseRes: QueryRes<CourseRow> = { data: [], error: null };
  const emptyCertRes: QueryRes<CertRow> = { data: [], error: null };

  const [orgRes, userRes, courseRes, certRes] = await Promise.all([
    orgIds.length > 0 ? (admin.from("organizations").select("id, name, slug").in("id", orgIds) as unknown as Promise<QueryRes<OrgRow>>) : Promise.resolve(emptyOrgRes),
    userIds.length > 0 ? (admin.from("users").select("id, full_name, email").in("id", userIds) as unknown as Promise<QueryRes<UserRow>>) : Promise.resolve(emptyUserRes),
    courseIds.length > 0 ? (admin.from("courses").select("id, title").in("id", courseIds) as unknown as Promise<QueryRes<CourseRow>>) : Promise.resolve(emptyCourseRes),
    courseIds.length > 0 && userIds.length > 0
      ? (admin
          .from("certificates")
          .select("user_id, course_id, issued_at, created_at")
          .in("course_id", courseIds)
          .in("user_id", userIds) as unknown as Promise<QueryRes<CertRow>>)
      : Promise.resolve(emptyCertRes),
  ]);

  const orgNameById = new Map<string, string>();
  for (const o of Array.isArray(orgRes.data) ? orgRes.data : []) {
    const label = (o.name ?? "").trim() || (o.slug ?? "").trim() || "Unnamed organization";
    orgNameById.set(o.id, label);
  }

  const userById = new Map<string, { full_name: string | null; email: string | null }>();
  for (const u of Array.isArray(userRes.data) ? userRes.data : []) {
    userById.set(u.id, { full_name: u.full_name ?? null, email: u.email ?? null });
  }

  const courseTitleById = new Map<string, string>();
  for (const c of Array.isArray(courseRes.data) ? courseRes.data : []) {
    courseTitleById.set(c.id, (c.title ?? "").trim() || "Untitled course");
  }

  const certIssuedAtByKey = new Map<string, string>();
  for (const r of Array.isArray(certRes.data) ? certRes.data : []) {
    const uid = typeof r.user_id === "string" ? r.user_id : null;
    const cid = typeof r.course_id === "string" ? r.course_id : null;
    if (!uid || !cid) continue;
    const ts = (typeof r.issued_at === "string" ? r.issued_at : null) ?? (typeof r.created_at === "string" ? r.created_at : null);
    if (!ts) continue;
    certIssuedAtByKey.set(`${uid}|${cid}`, ts);
  }

  return baseRows
    .map((r) => {
      const organization_id = typeof r.organization_id === "string" ? r.organization_id : "";
      const user_id = typeof r.user_id === "string" ? r.user_id : "";
      const course_id = typeof r.course_id === "string" ? r.course_id : "";
      if (!organization_id || !user_id || !course_id) return null;

      const u = userById.get(user_id) ?? { full_name: null, email: null };
      const issuedAt = certIssuedAtByKey.get(`${user_id}|${course_id}`) ?? null;

      return {
        organization_id,
        organization_name: orgNameById.get(organization_id) ?? null,
        user_id,
        user_email: u.email,
        user_full_name: u.full_name,
        course_id,
        course_title: courseTitleById.get(course_id) ?? null,
        enrollment_status: r.status ?? null,
        enrolled_at: r.enrolled_at ?? null,
        certified: Boolean(issuedAt),
        certificate_issued_at: issuedAt,
      } satisfies EnrollmentSummaryRow;
    })
    .filter((v): v is EnrollmentSummaryRow => Boolean(v));
}

export async function fetchEnrollmentSummaryPage(params: EnrollmentSummaryFilters & { page: number; pageSize: number }): Promise<{
  rows: EnrollmentSummaryRow[];
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

  let filterUserIds: string[] | null = null;
  let filterCourseIds: string[] | null = null;

  if (params.q && params.q.trim().length > 0) {
    const s = sanitizeSearchQuery(params.q);
    // Keep PostgREST filter strings small (avoid very long `or(...in.(...))`).
    const maxMatches = 200;

    const [usersRes, coursesRes] = await Promise.all([
      admin
        .from("users")
        .select("id")
        .or(`email.ilike.%${s}%,full_name.ilike.%${s}%`)
        .limit(maxMatches),
      admin
        .from("courses")
        .select("id")
        .ilike("title", `%${s}%`)
        .limit(maxMatches),
    ]);

    filterUserIds = (Array.isArray(usersRes.data) ? usersRes.data : [])
      .map((r: { id?: unknown }) => (typeof r.id === "string" ? r.id : null))
      .filter((v): v is string => typeof v === "string" && v.length > 0);

    filterCourseIds = (Array.isArray(coursesRes.data) ? coursesRes.data : [])
      .map((r: { id?: unknown }) => (typeof r.id === "string" ? r.id : null))
      .filter((v): v is string => typeof v === "string" && v.length > 0);

    // If q is set but matches nothing, return empty fast.
    if (filterUserIds.length === 0 && filterCourseIds.length === 0) {
      return { rows: [], count: 0, page, pageSize, totalPages: 1, error: null };
    }
  }

  let q = admin
    .from("course_enrollments")
    .select("organization_id, user_id, course_id, status, enrolled_at", { count: "exact" })
    .order("enrolled_at", { ascending: false })
    .range(fromIdx, toIdx);

  if (params.organizationId) q = q.eq("organization_id", params.organizationId);
  if (params.courseId) q = q.eq("course_id", params.courseId);
  if (params.userId) q = q.eq("user_id", params.userId);
  if (params.from) q = q.gte("enrolled_at", normalizeDateInput(params.from, "from"));
  if (params.to) q = q.lte("enrolled_at", normalizeDateInput(params.to, "to"));

  // Apply q-derived ID filters (OR semantics: matching user OR matching course)
  if (filterUserIds && filterCourseIds) {
    const userPart = filterUserIds.length > 0 ? `user_id.in.(${filterUserIds.join(",")})` : "";
    const coursePart = filterCourseIds.length > 0 ? `course_id.in.(${filterCourseIds.join(",")})` : "";
    const parts = [userPart, coursePart].filter(Boolean);
    if (parts.length > 0) q = q.or(parts.join(","));
  }

  const { data, error, count } = await q;
  if (error) return { rows: [], count: 0, page, pageSize, totalPages: 0, error: error.message };

  const total = typeof count === "number" ? count : 0;
  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;

  const baseRows = (Array.isArray(data) ? data : []) as Array<{
    organization_id?: string | null;
    user_id?: string | null;
    course_id?: string | null;
    status?: string | null;
    enrolled_at?: string | null;
  }>;

  let rows = await hydrateEnrollmentRows(baseRows);

  if (params.result && params.result !== "all") {
    rows = rows.filter((r) => (params.result === "certified" ? r.certified : !r.certified));
  }

  return { rows, count: total, page, pageSize, totalPages, error: null };
}

export async function fetchEnrollmentSummary(params: EnrollmentSummaryFilters): Promise<{ rows: EnrollmentSummaryRow[]; error: string | null }> {
  const admin = createAdminSupabaseClient();
  const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 50000) : 5000;

  let filterUserIds: string[] | null = null;
  let filterCourseIds: string[] | null = null;

  if (params.q && params.q.trim().length > 0) {
    const s = sanitizeSearchQuery(params.q);
    // Keep PostgREST filter strings small (avoid very long `or(...in.(...))`).
    const maxMatches = 200;

    const [usersRes, coursesRes] = await Promise.all([
      admin
        .from("users")
        .select("id")
        .or(`email.ilike.%${s}%,full_name.ilike.%${s}%`)
        .limit(maxMatches),
      admin
        .from("courses")
        .select("id")
        .ilike("title", `%${s}%`)
        .limit(maxMatches),
    ]);

    filterUserIds = (Array.isArray(usersRes.data) ? usersRes.data : [])
      .map((r: { id?: unknown }) => (typeof r.id === "string" ? r.id : null))
      .filter((v): v is string => typeof v === "string" && v.length > 0);

    filterCourseIds = (Array.isArray(coursesRes.data) ? coursesRes.data : [])
      .map((r: { id?: unknown }) => (typeof r.id === "string" ? r.id : null))
      .filter((v): v is string => typeof v === "string" && v.length > 0);

    if (filterUserIds.length === 0 && filterCourseIds.length === 0) {
      return { rows: [], error: null };
    }
  }

  let q = admin
    .from("course_enrollments")
    .select("organization_id, user_id, course_id, status, enrolled_at")
    .order("enrolled_at", { ascending: false })
    .limit(limit);

  if (params.organizationId) q = q.eq("organization_id", params.organizationId);
  if (params.courseId) q = q.eq("course_id", params.courseId);
  if (params.userId) q = q.eq("user_id", params.userId);
  if (params.from) q = q.gte("enrolled_at", normalizeDateInput(params.from, "from"));
  if (params.to) q = q.lte("enrolled_at", normalizeDateInput(params.to, "to"));

  if (filterUserIds && filterCourseIds) {
    const userPart = filterUserIds.length > 0 ? `user_id.in.(${filterUserIds.join(",")})` : "";
    const coursePart = filterCourseIds.length > 0 ? `course_id.in.(${filterCourseIds.join(",")})` : "";
    const parts = [userPart, coursePart].filter(Boolean);
    if (parts.length > 0) q = q.or(parts.join(","));
  }

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };

  const baseRows = (Array.isArray(data) ? data : []) as Array<{
    organization_id?: string | null;
    user_id?: string | null;
    course_id?: string | null;
    status?: string | null;
    enrolled_at?: string | null;
  }>;

  let rows = await hydrateEnrollmentRows(baseRows);

  if (params.result && params.result !== "all") {
    rows = rows.filter((r) => (params.result === "certified" ? r.certified : !r.certified));
  }

  return { rows, error: null };
}

export async function fetchTopCourses(params: EnrollmentSummaryFilters & { limit?: number }): Promise<{ rows: TopBucket[]; error: string | null }> {
  const admin = createAdminSupabaseClient();
  const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 20) : 5;

  let q = admin.from("course_enrollments").select("course_id").limit(50000);
  if (params.organizationId) q = q.eq("organization_id", params.organizationId);
  if (params.courseId) q = q.eq("course_id", params.courseId);
  if (params.userId) q = q.eq("user_id", params.userId);
  if (params.from) q = q.gte("enrolled_at", normalizeDateInput(params.from, "from"));
  if (params.to) q = q.lte("enrolled_at", normalizeDateInput(params.to, "to"));

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };

  const countsById: Record<string, number> = {};
  for (const r of (Array.isArray(data) ? data : []) as Array<{ course_id?: unknown }>) {
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

export async function fetchTopUsersByCertificates(params: EnrollmentSummaryFilters & { limit?: number }): Promise<{ rows: TopBucket[]; error: string | null }> {
  const admin = createAdminSupabaseClient();
  const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 20) : 5;

  let q = admin.from("certificates").select("user_id").limit(50000);
  if (params.organizationId) q = q.eq("organization_id", params.organizationId);
  if (params.courseId) q = q.eq("course_id", params.courseId);
  if (params.userId) q = q.eq("user_id", params.userId);
  if (params.from) q = q.gte("issued_at", normalizeDateInput(params.from, "from"));
  if (params.to) q = q.lte("issued_at", normalizeDateInput(params.to, "to"));

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };

  const countsById: Record<string, number> = {};
  for (const r of (Array.isArray(data) ? data : []) as Array<{ user_id?: unknown }>) {
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
      labelById[u.id] = fullName.length > 0 ? fullName : (email.length > 0 ? email : "Unknown user");
    }
  }

  return { rows: buckets.map((b) => ({ id: b.id, label: labelById[b.id] ?? "Unknown user", count: b.count })), error: null };
}

export async function fetchOrgReportStats(orgId: string): Promise<{
  usersCount: number;
  enrollmentsCount: number;
  certifiedCount: number;
  notCertifiedCount: number;
  certificationRate: number;
  error: string | null;
}> {
  const admin = createAdminSupabaseClient();

  const usersRes = await admin.from("users").select("id", { count: "exact", head: true }).eq("organization_id", orgId);
  if (usersRes.error) {
    return { usersCount: 0, enrollmentsCount: 0, certifiedCount: 0, notCertifiedCount: 0, certificationRate: 0, error: usersRes.error.message };
  }
  const usersCount = typeof usersRes.count === "number" ? usersRes.count : 0;

  const enrRes = await admin.from("course_enrollments").select("id", { count: "exact", head: true }).eq("organization_id", orgId);
  if (enrRes.error) {
    return { usersCount, enrollmentsCount: 0, certifiedCount: 0, notCertifiedCount: 0, certificationRate: 0, error: enrRes.error.message };
  }
  const enrollmentsCount = typeof enrRes.count === "number" ? enrRes.count : 0;

  const certRes = await admin.from("certificates").select("id", { count: "exact", head: true }).eq("organization_id", orgId);
  const certifiedCount = typeof certRes.count === "number" ? certRes.count : 0;
  const notCertifiedCount = Math.max(0, enrollmentsCount - certifiedCount);
  const certificationRate = enrollmentsCount > 0 ? Math.round((certifiedCount / enrollmentsCount) * 100) : 0;

  return { usersCount, enrollmentsCount, certifiedCount, notCertifiedCount, certificationRate, error: certRes.error ? certRes.error.message : null };
}

export async function fetchEnrollmentsDaily(params: {
  organizationId?: string;
  days?: number; // used only when from/to not provided
  from?: string; // ISO
  to?: string; // ISO
}): Promise<{ points: Array<{ day: string; count: number }>; error: string | null }> {
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

  const points: Array<{ day: string; count: number }> = [];
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

