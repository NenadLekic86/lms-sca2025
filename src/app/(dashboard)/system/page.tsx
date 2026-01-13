import { LayoutDashboard, Building2, UserCog, BookOpen, Award, FileText } from "lucide-react";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

type Stat = { label: string; value: string; icon: LucideIcon; color: string; error?: string | null };

async function safeCount(admin: ReturnType<typeof createAdminSupabaseClient>, table: string, filter?: { column: string; value: unknown }) {
  try {
    let q = admin.from(table).select("*", { count: "exact", head: true });
    if (filter) q = q.eq(filter.column, filter.value);
    const { count, error } = await q;
    return { count: typeof count === "number" ? count : 0, error: error?.message ?? null };
  } catch (e) {
    return { count: 0, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

type AuditLogRow = {
  id: string;
  created_at?: string | null;
  action?: string | null;
  actor_email?: string | null;
  actor_role?: string | null;
  entity?: string | null;
  entity_id?: string | null;
  metadata?: unknown | null;
  target_user_id?: string | null;
};

type OrgRow = {
  id: string;
  name?: string | null;
  slug?: string | null;
  created_at?: string | null;
  is_active?: boolean | null;
};

type SearchParams = Record<string, string | string[] | undefined>;
function spGet(sp: SearchParams, key: string): string | null {
  const v = sp[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : null;
  return null;
}

function buildPager(current: number, total: number): Array<number | "ellipsis"> {
  const t = Math.max(1, Math.floor(total));
  const c = Math.min(Math.max(1, Math.floor(current)), t);
  if (t <= 7) return Array.from({ length: t }, (_, i) => i + 1);

  const pages = new Set<number>([1, t, c, c - 1, c + 1]);
  const list = Array.from(pages).filter((p) => p >= 1 && p <= t).sort((a, b) => a - b);
  const out: Array<number | "ellipsis"> = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const prev = list[i - 1];
    if (typeof prev === "number" && p - prev > 1) out.push("ellipsis");
    out.push(p);
  }
  return out;
}

export default async function SystemDashboardPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams> | SearchParams;
}) {
  return <SystemDashboardContent searchParams={searchParams} />;
}

async function SystemDashboardContent(props: { searchParams?: Promise<SearchParams> | SearchParams }) {
  const { user, error } = await getServerUser();
  if (error || !user) return null;
  if (!["super_admin", "system_admin"].includes(user.role)) return null;

  const admin = createAdminSupabaseClient();
  const sp = (await props.searchParams) ?? {};
  const activityPage = Number(spGet(sp, "activity_page") ?? "1");
  const activityPageSize = 10;
  const safeActivityPage = Number.isFinite(activityPage) && activityPage > 0 ? Math.floor(activityPage) : 1;

  const [orgsTotal, orgsInactive, orgAdmins, courses, certificates] = await Promise.all([
    safeCount(admin, "organizations"),
    safeCount(admin, "organizations", { column: "is_active", value: false }),
    safeCount(admin, "users", { column: "role", value: "organization_admin" }),
    safeCount(admin, "courses"),
    safeCount(admin, "certificates"),
  ]);

  const activeOrgsCount = Math.max(0, orgsTotal.count - orgsInactive.count);
  const orgsCountError = orgsTotal.error || orgsInactive.error;

  const stats: Stat[] = [
    {
      label: "Organizations (Active / Inactive)",
      value: `${activeOrgsCount} / ${orgsInactive.count}`,
      icon: Building2,
      color: "bg-blue-500",
      error: orgsCountError,
    },
    { label: "Org Admins", value: String(orgAdmins.count), icon: UserCog, color: "bg-indigo-500", error: orgAdmins.error },
    { label: "Total Courses", value: String(courses.count), icon: BookOpen, color: "bg-purple-500", error: courses.error },
    { label: "Certificates Issued", value: String(certificates.count), icon: Award, color: "bg-amber-500", error: certificates.error },
  ];

  const { count: activityCountRaw, error: activityCountError } = await admin
    .from("audit_logs")
    .select("id", { count: "exact", head: true });

  const activityTotalCount = typeof activityCountRaw === "number" ? activityCountRaw : 0;
  const activityTotalPages = activityTotalCount > 0 ? Math.max(1, Math.ceil(activityTotalCount / activityPageSize)) : 1;
  const activityCurrent = activityCountError ? safeActivityPage : Math.min(Math.max(1, safeActivityPage), activityTotalPages);

  const activityFromIdx = (Math.max(1, activityCurrent) - 1) * activityPageSize;
  const activityToIdx = activityFromIdx + activityPageSize - 1;

  const { data: recentAudit, error: auditError } = await admin
    .from("audit_logs")
    .select("id, created_at, action, actor_email, actor_role, entity, entity_id, target_user_id, metadata")
    .order("created_at", { ascending: false })
    .range(activityFromIdx, activityToIdx);

  const auditRows = (Array.isArray(recentAudit) ? recentAudit : []) as AuditLogRow[];


  const activityHref = (p: number) => {
    const u = new URLSearchParams();
    u.set("activity_page", String(p));
    return `?${u.toString()}`;
  };

  // Per-organization overview counts (best-effort; do not hard-fail dashboard)
  const { data: orgData, error: orgLoadError } = await admin
    .from("organizations")
    .select("id, name, slug, created_at, is_active")
    .order("created_at", { ascending: false });

  const orgRows = (Array.isArray(orgData) ? orgData : []) as OrgRow[];

  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

  const getMetaString = (m: Record<string, unknown> | null, key: string): string | null => {
    const val = m?.[key];
    return typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
  };

  const orgLabelById = new Map<string, string>();
  for (const o of orgRows) {
    const id = typeof o.id === "string" ? o.id : null;
    if (!id) continue;
    const name = typeof o.name === "string" && o.name.trim().length ? o.name.trim() : null;
    const slug = typeof o.slug === "string" && o.slug.trim().length ? o.slug.trim() : null;
    orgLabelById.set(id, name ?? slug ?? id);
  }

  const orgLabel = (orgId: string | null) => {
    if (!orgId) return "No organization";
    return orgLabelById.get(orgId) ?? orgId;
  };

  const testLabelById = new Map<string, string>();
  const testCourseById = new Map<string, string | null>();
  const testLabel = (testId: string | null) => {
    if (!testId) return "Unknown test";
    return testLabelById.get(testId) ?? "Unknown test";
  };

  const getDetails = (row: AuditLogRow) => {
    const meta = asRecord(row.metadata);

    const getMetaNumber = (m: Record<string, unknown> | null, key: string): number | null => {
      const v = m?.[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      const n = typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    };

    if (row.action === "assign_user_organization") {
      const toOrgId = getMetaString(meta, "organization_id");
      const toOrgName = getMetaString(meta, "organization_name");
      const fromOrgId = getMetaString(meta, "previous_organization_id");
      const fromText = orgLabel(fromOrgId);
      const toText = toOrgName ?? orgLabel(toOrgId);
      return `Moved org: ${fromText} → ${toText}`;
    }

    const actorDisplay = row.actor_email
      ? `${row.actor_email}${row.actor_role ? ` (${roleLabel(row.actor_role)})` : ""}`
      : "Someone";

    // Exports
    const action = row.action ?? "";
    if (action.startsWith("export_")) {
      const exportKey = action.slice("export_".length);
      const exportName =
        exportKey === "users"
          ? "Users"
          : exportKey === "enrollments"
            ? "Enrollments"
            : exportKey === "certificates"
              ? "Certificates"
              : exportKey === "courses"
                ? "Courses"
                : exportKey === "organizations"
                  ? "Organizations"
                  : exportKey;

      const fmt = (getMetaString(meta, "format") ?? "csv").toUpperCase();
      const rowCount = getMetaNumber(meta, "row_count");
      const oid =
        (row.entity === "organizations" && typeof row.entity_id === "string" && row.entity_id.length > 0)
          ? row.entity_id
          : getMetaString(meta, "organization_id");
      const orgText = oid ? orgLabel(oid) : "all organizations";
      const rowsText = typeof rowCount === "number" ? ` • ${rowCount} rows` : "";
      return `${actorDisplay} exported ${exportName} (${fmt})${rowsText} for ${orgText}.`;
    }

    if (row.action === "enable_organization" || row.action === "disable_organization") {
      const orgId =
        (typeof row.entity_id === "string" && row.entity_id.length > 0)
          ? row.entity_id
          : getMetaString(meta, "organization_id");
      const name = orgLabel(orgId);
      return row.action === "enable_organization" ? `${name} is Active` : `${name} is Inactive`;
    }

    if (row.action === "create_organization") {
      const orgNameFromMeta = getMetaString(meta, "name");
      const orgId = (typeof row.entity_id === "string" && row.entity_id.length > 0) ? row.entity_id : null;
      const name = orgNameFromMeta ?? orgLabel(orgId);
      return `Organization created: ${name}.`;
    }

    if (row.action === "enable_user" || row.action === "disable_user") {
      const uid =
        (typeof row.target_user_id === "string" && row.target_user_id.length > 0)
          ? row.target_user_id
          : (row.entity === "users" && typeof row.entity_id === "string" ? row.entity_id : null);
      const resolved = uid ? userDisplayById.get(uid) : null;
      const label = resolved?.label ?? uid ?? "Unknown user";
      return row.action === "enable_user" ? `${label} is Active` : `${label} is Disabled`;
    }

    if (row.action === "upload_org_logo") {
      return `${actorDisplay} has uploaded new logo.`;
    }

    if (row.action === "upload_branding_logo") {
      return `${actorDisplay} has uploaded new logo.`;
    }

    if (row.action === "upload_user_avatar") {
      return `${actorDisplay} has updated their avatar.`;
    }

    if (row.action === "remove_user_avatar") {
      return `${actorDisplay} has removed their avatar.`;
    }

    if (row.action === "set_user_avatar_preset") {
      const preset = getMetaString(meta, "preset_name");
      return `${actorDisplay} has selected a preset avatar${preset ? ` (${preset})` : ""}.`;
    }

    if (row.action === "update_public_app_settings") {
      return `${actorDisplay} has updated General Settings.`;
    }

    if (row.action === "invite_user") {
      const invited = getMetaString(meta, "invited_email") ?? "a user";
      return `${actorDisplay} has invited ${invited}.`;
    }

    if (row.action === "send_password_setup_link") {
      const uid =
        (typeof row.target_user_id === "string" && row.target_user_id.length > 0)
          ? row.target_user_id
          : (row.entity === "users" && typeof row.entity_id === "string" ? row.entity_id : null);
      const resolved = uid ? userDisplayById.get(uid) : null;
      const label = resolved?.label ?? uid ?? "a user";
      return `${actorDisplay} sent a password setup link to ${label}.`;
    }

    if (row.action === "upload_course_cover") {
      const courseId = typeof row.entity_id === "string" && row.entity_id.length > 0 ? row.entity_id : null;
      return `${actorDisplay} added ${courseLabel(courseId)} cover image.`;
    }

    if (row.action === "upload_certificate_template") {
      const courseId = typeof row.entity_id === "string" && row.entity_id.length > 0 ? row.entity_id : null;
      const fileName = getMetaString(meta, "file_name");
      return `${actorDisplay} uploaded certificate template${fileName ? ` (${fileName})` : ""} for ${courseLabel(courseId)}.`;
    }

    if (row.action === "upload_course_resource") {
      const courseId = typeof row.entity_id === "string" && row.entity_id.length > 0 ? row.entity_id : null;
      const fileName = getMetaString(meta, "file_name");
      return `${actorDisplay} uploaded course resource${fileName ? ` (${fileName})` : ""} to ${courseLabel(courseId)}.`;
    }

    if (row.action === "create_course_test") {
      const courseId = typeof row.entity_id === "string" && row.entity_id.length > 0 ? row.entity_id : null;
      const tid = getMetaString(meta, "test_id");
      const tName = tid ? testLabel(tid) : "Assessment";
      return `${actorDisplay} created ${tName} for ${courseLabel(courseId)}.`;
    }

    if (row.action === "update_test_builder") {
      const testId = typeof row.entity_id === "string" && row.entity_id.length > 0 ? row.entity_id : null;
      const count = getMetaNumber(meta, "questions");
      const countText = typeof count === "number" ? ` (${count} questions)` : "";
      const cId = testId ? (testCourseById.get(testId) ?? null) : null;
      const courseText = cId ? ` for ${courseLabel(cId)}` : "";
      return `${actorDisplay} updated test builder${countText}: ${testLabel(testId)}${courseText}.`;
    }
    return "—";
  };

  const roleLabel = (role: string | null) => {
    switch (role) {
      case "super_admin":
        return "Super Admin";
      case "system_admin":
        return "System Admin";
      case "organization_admin":
        return "Organization Admin";
      case "member":
        return "Member";
      default:
        return role ?? "";
    }
  };

  const userIds = new Set<string>();
  const courseIds = new Set<string>();
  const testIds = new Set<string>();
  for (const row of auditRows) {
    if (typeof row.target_user_id === "string" && row.target_user_id.length > 0) userIds.add(row.target_user_id);
    else if (row.entity === "users" && typeof row.entity_id === "string" && row.entity_id.length > 0) userIds.add(row.entity_id);

    if (row.entity === "courses" && typeof row.entity_id === "string" && row.entity_id.length > 0) {
      courseIds.add(row.entity_id);
    }
    if (row.action === "upload_course_cover" && typeof row.entity_id === "string" && row.entity_id.length > 0) {
      courseIds.add(row.entity_id);
    }

    if (row.entity === "tests" && typeof row.entity_id === "string" && row.entity_id.length > 0) {
      testIds.add(row.entity_id);
    }
    if (row.action === "update_test_builder" && typeof row.entity_id === "string" && row.entity_id.length > 0) {
      testIds.add(row.entity_id);
    }

    const meta = asRecord(row.metadata);
    if (row.action === "create_course_test") {
      const tid = getMetaString(meta, "test_id");
      if (tid) testIds.add(tid);
    }
  }

  const userDisplayById = new Map<string, { label: string; role: string | null }>();
  if (userIds.size > 0) {
    const { data: usersData, error: usersError } = await admin
      .from("users")
      .select("id, full_name, email, role")
      .in("id", Array.from(userIds));

    if (!usersError && Array.isArray(usersData)) {
      for (const u of usersData as Array<{ id?: unknown; full_name?: unknown; email?: unknown; role?: unknown }>) {
        const id = typeof u.id === "string" ? u.id : null;
        if (!id) continue;
        const fullName = typeof u.full_name === "string" && u.full_name.trim().length ? u.full_name.trim() : null;
        const email = typeof u.email === "string" && u.email.trim().length ? u.email.trim() : null;
        const role = typeof u.role === "string" ? u.role : null;
        userDisplayById.set(id, { label: fullName ?? email ?? id, role });
      }
    }
  }

  const courseLabelById = new Map<string, string>();
  if (courseIds.size > 0) {
    const { data: coursesData, error: coursesError } = await admin
      .from("courses")
      .select("id, title")
      .in("id", Array.from(courseIds));

    if (!coursesError && Array.isArray(coursesData)) {
      for (const c of coursesData as Array<{ id?: unknown; title?: unknown }>) {
        const id = typeof c.id === "string" ? c.id : null;
        if (!id) continue;
        const title = typeof c.title === "string" && c.title.trim().length ? c.title.trim() : null;
        courseLabelById.set(id, title ?? "Untitled course");
      }
    }
  }

  const courseLabel = (courseId: string | null) => {
    if (!courseId) return "Unknown course";
    return courseLabelById.get(courseId) ?? "Unknown course";
  };

  if (testIds.size > 0) {
    const { data: testsData, error: testsError } = await admin
      .from("tests")
      .select("id, title, course_id")
      .in("id", Array.from(testIds));

    if (!testsError && Array.isArray(testsData)) {
      for (const t of testsData as Array<{ id?: unknown; title?: unknown; course_id?: unknown }>) {
        const id = typeof t.id === "string" ? t.id : null;
        if (!id) continue;
        const title = typeof t.title === "string" && t.title.trim().length ? t.title.trim() : null;
        const courseId = typeof t.course_id === "string" && t.course_id.length > 0 ? t.course_id : null;
        testLabelById.set(id, title ?? "Untitled test");
        testCourseById.set(id, courseId);
      }
    }
  }

  // If tests referenced a course_id we didn't already fetch, hydrate those course titles too.
  const courseIdsFromTests = Array.from(new Set(Array.from(testCourseById.values()).filter((v): v is string => typeof v === "string" && v.length > 0)));
  const missingCourseIds = courseIdsFromTests.filter((id) => !courseLabelById.has(id));
  if (missingCourseIds.length > 0) {
    const { data: moreCourses, error: moreCoursesError } = await admin
      .from("courses")
      .select("id, title")
      .in("id", missingCourseIds);

    if (!moreCoursesError && Array.isArray(moreCourses)) {
      for (const c of moreCourses as Array<{ id?: unknown; title?: unknown }>) {
        const id = typeof c.id === "string" ? c.id : null;
        if (!id) continue;
        const title = typeof c.title === "string" && c.title.trim().length ? c.title.trim() : null;
        courseLabelById.set(id, title ?? "Untitled course");
      }
    }
  }

  const getSubjectDisplay = (row: AuditLogRow) => {
    const meta = asRecord(row.metadata);

    if (
      row.action === "assign_user_organization" ||
      row.action === "disable_user" ||
      row.action === "enable_user" ||
      row.action === "invite_user" ||
      row.action === "send_password_setup_link" ||
      row.action === "upload_user_avatar" ||
      row.action === "remove_user_avatar" ||
      row.action === "set_user_avatar_preset"
    ) {
      const uid =
        (typeof row.target_user_id === "string" && row.target_user_id.length > 0)
          ? row.target_user_id
          : (row.entity === "users" && typeof row.entity_id === "string" ? row.entity_id : null);

      const fromMetaName = getMetaString(meta, "full_name");
      const fromMetaEmail = getMetaString(meta, "invited_email");
      const roleFromMeta = getMetaString(meta, "invited_role");
      const resolved = uid ? userDisplayById.get(uid) : null;
      const label = resolved?.label ?? fromMetaName ?? fromMetaEmail ?? uid ?? "Unknown user";
      const role = resolved?.role ?? roleFromMeta ?? null;
      return `users (${label}${role ? ` / ${roleLabel(role)}` : ""})`;
    }

    if (row.action === "disable_organization" || row.action === "enable_organization" || row.action === "create_organization") {
      const orgNameFromMeta = getMetaString(meta, "name");
      const orgId = (typeof row.entity_id === "string" && row.entity_id.length > 0) ? row.entity_id : getMetaString(meta, "organization_id");
      const label = orgNameFromMeta ?? orgLabel(orgId);
      return `organizations (${label})`;
    }

    if (row.action === "upload_org_logo" || row.action === "remove_org_logo") {
      const orgId = (typeof row.entity_id === "string" && row.entity_id.length > 0) ? row.entity_id : getMetaString(meta, "organization_id");
      return `storage.org-logos (${orgLabel(orgId)})`;
    }

    if (row.action === "upload_branding_logo") {
      return "storage.branding (global)";
    }

    // Exports
    const action = row.action ?? "";
    if (action.startsWith("export_")) {
      const oid =
        (row.entity === "organizations" && typeof row.entity_id === "string" && row.entity_id.length > 0)
          ? row.entity_id
          : getMetaString(meta, "organization_id");
      if (oid) return `organizations (${orgLabel(oid)})`;
      return "system (all organizations)";
    }

    // Organizations (generic)
    if (row.entity === "organizations" && typeof row.entity_id === "string" && row.entity_id.length > 0) {
      return `organizations (${orgLabel(row.entity_id)})`;
    }

    if (row.entity === "tests" && typeof row.entity_id === "string" && row.entity_id.length > 0) {
      return `tests (${testLabel(row.entity_id)})`;
    }
    if (row.action === "update_test_builder" && typeof row.entity_id === "string" && row.entity_id.length > 0) {
      return `tests (${testLabel(row.entity_id)})`;
    }

    if (row.entity === "courses" && typeof row.entity_id === "string" && row.entity_id.length > 0) {
      return `courses (${courseLabel(row.entity_id)})`;
    }
    if (row.action === "upload_course_cover" && typeof row.entity_id === "string" && row.entity_id.length > 0) {
      return `courses (${courseLabel(row.entity_id)})`;
    }


    return row.entity ? `${row.entity}${row.entity_id ? ` (${row.entity_id})` : ""}` : "-";
  };

  let usersCountsError: string | null = null;
  let coursesCountsError: string | null = null;
  let certificatesCountsError: string | null = null;

  const usersTotalByOrg: Record<string, number> = {};
  const usersActiveByOrg: Record<string, number> = {};
  const usersDisabledByOrg: Record<string, number> = {};
  const coursesByOrg: Record<string, number> = {};
  const certificatesByOrg: Record<string, number> = {};

  try {
    const { data: usersData, error: usersError } = await admin
      .from("users")
      .select("organization_id, is_active");
    if (usersError) {
      usersCountsError = usersError.message;
    } else {
      for (const row of (Array.isArray(usersData) ? usersData : []) as Array<{ organization_id?: string | null; is_active?: boolean | null }>) {
        const orgId = row.organization_id;
        if (!orgId) continue;
        usersTotalByOrg[orgId] = (usersTotalByOrg[orgId] || 0) + 1;
        if (row.is_active === false) {
          usersDisabledByOrg[orgId] = (usersDisabledByOrg[orgId] || 0) + 1;
        } else {
          usersActiveByOrg[orgId] = (usersActiveByOrg[orgId] || 0) + 1;
        }
      }
    }
  } catch (e) {
    usersCountsError = e instanceof Error ? e.message : "Failed to load users";
  }

  try {
    const { data: coursesData, error: coursesError } = await admin
      .from("courses")
      .select("organization_id");
    if (coursesError) {
      coursesCountsError = coursesError.message;
    } else {
      for (const row of (Array.isArray(coursesData) ? coursesData : []) as Array<{ organization_id?: string | null }>) {
        const orgId = row.organization_id;
        if (!orgId) continue;
        coursesByOrg[orgId] = (coursesByOrg[orgId] || 0) + 1;
      }
    }
  } catch (e) {
    coursesCountsError = e instanceof Error ? e.message : "Failed to load courses";
  }

  try {
    const { data: certData, error: certError } = await admin
      .from("certificates")
      .select("organization_id");
    if (certError) {
      certificatesCountsError = certError.message;
    } else {
      for (const row of (Array.isArray(certData) ? certData : []) as Array<{ organization_id?: string | null }>) {
        const orgId = row.organization_id;
        if (!orgId) continue;
        certificatesByOrg[orgId] = (certificatesByOrg[orgId] || 0) + 1;
      }
    }
  } catch (e) {
    certificatesCountsError = e instanceof Error ? e.message : "Failed to load certificates";
  }

  const orgOverview = orgRows.map((o) => ({
    ...o,
    users_total: usersTotalByOrg[o.id] || 0,
    users_active: usersActiveByOrg[o.id] || 0,
    users_disabled: usersDisabledByOrg[o.id] || 0,
    courses_count: coursesByOrg[o.id] || 0,
    certificates_count: certificatesByOrg[o.id] || 0,
  }));

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-3">
        <LayoutDashboard className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold text-foreground">System Dashboard</h1>
          <p className="text-muted-foreground">
            {user.full_name && user.full_name.trim().length > 0
              ? `Welcome back System Administrator, ${user.full_name.trim()}`
              : "Welcome back, System Administrator"}
          </p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className="bg-card border rounded-lg p-6 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{stat.label}</p>
                  <p className="text-3xl font-bold text-foreground mt-1">{stat.value}</p>
                  {stat.error ? (
                    <p className="mt-1 text-xs text-destructive">
                      {stat.error.includes("relation") ? "Missing table / schema" : stat.error}
                    </p>
                  ) : null}
                </div>
                <div className={`${stat.color} p-3 rounded-lg`}>
                  <Icon className="h-6 w-6 text-white" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 md:grid-cols-1 gap-6">
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Organizations Overview
          </h2>

          {orgLoadError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              Failed to load organizations: {orgLoadError.message}
            </div>
          ) : null}

          {usersCountsError ? (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              User counts not available: {usersCountsError}
            </div>
          ) : null}
          {coursesCountsError ? (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Courses counts not available: {coursesCountsError}
            </div>
          ) : null}
          {certificatesCountsError ? (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Certificates counts not available: {certificatesCountsError}
            </div>
          ) : null}

          <div className="mt-4 overflow-hidden rounded-lg border">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Organization</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Courses</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Users (A / D / T)</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Certificates</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {orgOverview.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                        No organizations found.
                      </td>
                    </tr>
                  ) : (
                    orgOverview.map((o) => (
                      <tr key={o.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="min-w-[220px]">
                            <div className="font-medium text-foreground">
                              {o.name && o.name.trim().length > 0 ? o.name : (o.slug && o.slug.trim().length > 0 ? o.slug : o.id)}
                            </div>
                            <div className="text-xs text-muted-foreground font-mono">{o.slug ?? o.id}</div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-foreground tabular-nums">{o.courses_count}</td>
                        <td className="px-4 py-3 text-right text-sm text-foreground tabular-nums whitespace-nowrap">
                          {o.users_active} / {o.users_disabled} / {o.users_total}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-foreground tabular-nums">{o.certificates_count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Recent Activity
          </h2>
          {auditError ? (
            <div className="text-sm text-destructive">Failed to load audit logs: {auditError.message}</div>
          ) : auditRows.length === 0 ? (
            <div className="text-muted-foreground text-center py-8">
              <p>No activity yet.</p>
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Time</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Action</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Details</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Subject</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {auditRows.map((row) => (
                      <tr key={row.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2 text-xs text-muted-foreground font-mono">
                          {row.created_at ? new Date(row.created_at).toLocaleString() : "-"}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {row.action ?? "-"}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {getDetails(row)}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {getSubjectDisplay(row)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 flex items-center justify-between gap-3 text-sm">
                <div className="text-muted-foreground">
                  {activityTotalCount > 0 ? (
                    <span>
                      Showing {activityFromIdx + 1}–{Math.min(activityFromIdx + auditRows.length, activityTotalCount)} of {activityTotalCount}
                    </span>
                  ) : (
                    <span>Showing 0 results</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {(() => {
                    const onlyOne = activityTotalPages <= 1;
                    const prevDisabled = onlyOne || activityCurrent <= 1;
                    const nextDisabled = onlyOne || activityCurrent >= activityTotalPages;
                    const pager = buildPager(activityCurrent, activityTotalPages);

                    return (
                      <>
                        {prevDisabled ? (
                          <Button variant="outline" disabled>
                            Prev
                          </Button>
                        ) : (
                          <Button asChild variant="outline">
                            <a href={activityHref(activityCurrent - 1)}>Prev</a>
                          </Button>
                        )}

                        <div className="flex items-center gap-1">
                          {pager.map((p, idx) =>
                            p === "ellipsis" ? (
                              <span key={`e-${idx}`} className="px-2 text-muted-foreground select-none">
                                …
                              </span>
                            ) : p === activityCurrent ? (
                              <Button key={p} disabled>
                                {p}
                              </Button>
                            ) : (
                              <Button key={p} asChild variant="outline">
                                <a href={activityHref(p)}>{p}</a>
                              </Button>
                            )
                          )}
                        </div>

                        {nextDisabled ? (
                          <Button variant="outline" disabled>
                            Next
                          </Button>
                        ) : (
                          <Button asChild variant="outline">
                            <a href={activityHref(activityCurrent + 1)}>Next</a>
                          </Button>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

