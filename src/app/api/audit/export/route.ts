import { NextRequest, NextResponse } from "next/server";

import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

type AuditLogRow = {
  id: string;
  created_at?: string | null;
  action?: string | null;
  actor_email?: string | null;
  actor_role?: string | null;
  entity?: string | null;
  entity_id?: string | null;
  target_user_id?: string | null;
  metadata?: unknown;
};

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  const escaped = s.replace(/"/g, '""');
  return `"${escaped}"`;
}

function buildCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "No data\n";
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.map(csvEscape).join(","),
    ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")),
  ];
  return lines.join("\n") + "\n";
}

function parseIntParam(v: string | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function getMetaString(m: Record<string, unknown> | null, key: string): string | null {
  const val = m?.[key];
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
}

function getMetaNumber(m: Record<string, unknown> | null, key: string): number | null {
  const v = m?.[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function roleLabel(role: string | null) {
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
}

function takeFirst<T>(arr: T[], limit: number): T[] {
  if (arr.length <= limit) return arr;
  return arr.slice(0, limit);
}

export async function GET(request: NextRequest) {
  const { user, error } = await getServerUser();
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const max = Math.min(parseIntParam(url.searchParams.get("max"), 50000), 50000);

  const admin = createAdminSupabaseClient();

  const { data, error: loadError } = await admin
    .from("audit_logs")
    .select("id, created_at, action, actor_email, actor_role, entity, entity_id, target_user_id, metadata")
    .order("created_at", { ascending: false })
    .range(0, Math.max(0, max - 1));

  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });

  const rows = (Array.isArray(data) ? data : []) as AuditLogRow[];

  // Build lookup sets (cap to avoid huge IN() queries)
  const orgIds = new Set<string>();
  const userIds = new Set<string>();
  const courseIds = new Set<string>();
  const testIds = new Set<string>();

  for (const row of rows) {
    const meta = asRecord(row.metadata);

    // users
    if (typeof row.target_user_id === "string" && row.target_user_id.length > 0) userIds.add(row.target_user_id);
    else if (row.entity === "users" && typeof row.entity_id === "string" && row.entity_id.length > 0) userIds.add(row.entity_id);

    // orgs referenced in metadata
    const toOrgId = getMetaString(meta, "organization_id");
    const fromOrgId = getMetaString(meta, "previous_organization_id");
    if (toOrgId) orgIds.add(toOrgId);
    if (fromOrgId) orgIds.add(fromOrgId);

    // orgs by entity_id for org-related actions
    if (
      row.action === "disable_organization" ||
      row.action === "enable_organization" ||
      row.action === "create_organization" ||
      row.action === "upload_org_logo" ||
      row.action === "remove_org_logo"
    ) {
      if (typeof row.entity_id === "string" && row.entity_id.length > 0) orgIds.add(row.entity_id);
    }

    // courses
    if (row.entity === "courses" && typeof row.entity_id === "string" && row.entity_id.length > 0) courseIds.add(row.entity_id);
    if (row.action === "upload_course_cover" && typeof row.entity_id === "string" && row.entity_id.length > 0) courseIds.add(row.entity_id);
    if (
      (row.action === "upload_certificate_template" || row.action === "upload_course_resource" || row.action === "create_course_test") &&
      typeof row.entity_id === "string" &&
      row.entity_id.length > 0
    ) {
      courseIds.add(row.entity_id);
    }

    // tests
    if (row.entity === "tests" && typeof row.entity_id === "string" && row.entity_id.length > 0) testIds.add(row.entity_id);
    if (row.action === "update_test_builder" && typeof row.entity_id === "string" && row.entity_id.length > 0) testIds.add(row.entity_id);
    if (row.action === "create_course_test") {
      const tid = getMetaString(meta, "test_id");
      if (tid) testIds.add(tid);
    }
  }

  const orgLabelById = new Map<string, string>();
  const userDisplayById = new Map<string, { label: string; role: string | null }>();
  const courseLabelById = new Map<string, string>();
  const testLabelById = new Map<string, string>();
  const testCourseById = new Map<string, string | null>();

  const ORG_ID_LIMIT = 1000;
  const USER_ID_LIMIT = 1000;
  const COURSE_ID_LIMIT = 1000;
  const TEST_ID_LIMIT = 1000;

  const orgIdList = takeFirst(Array.from(orgIds), ORG_ID_LIMIT);
  const userIdList = takeFirst(Array.from(userIds), USER_ID_LIMIT);
  const courseIdList = takeFirst(Array.from(courseIds), COURSE_ID_LIMIT);
  const testIdList = takeFirst(Array.from(testIds), TEST_ID_LIMIT);

  if (orgIdList.length > 0) {
    const { data: orgData, error: orgError } = await admin.from("organizations").select("id, name, slug").in("id", orgIdList);
    if (!orgError && Array.isArray(orgData)) {
      for (const o of orgData as Array<{ id?: unknown; name?: unknown; slug?: unknown }>) {
        const id = typeof o.id === "string" ? o.id : null;
        if (!id) continue;
        const name = typeof o.name === "string" && o.name.trim().length ? o.name.trim() : null;
        const slug = typeof o.slug === "string" && o.slug.trim().length ? o.slug.trim() : null;
        orgLabelById.set(id, name ?? slug ?? id);
      }
    }
  }

  if (userIdList.length > 0) {
    const { data: usersData, error: usersError } = await admin.from("users").select("id, full_name, email, role").in("id", userIdList);
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

  if (courseIdList.length > 0) {
    const { data: coursesData, error: coursesError } = await admin.from("courses").select("id, title").in("id", courseIdList);
    if (!coursesError && Array.isArray(coursesData)) {
      for (const c of coursesData as Array<{ id?: unknown; title?: unknown }>) {
        const id = typeof c.id === "string" ? c.id : null;
        if (!id) continue;
        const title = typeof c.title === "string" && c.title.trim().length ? c.title.trim() : null;
        courseLabelById.set(id, title ?? "Untitled course");
      }
    }
  }

  if (testIdList.length > 0) {
    const { data: testsData, error: testsError } = await admin.from("tests").select("id, title, course_id").in("id", testIdList);
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

  // hydrate missing courses referenced by tests (only for the small hydrated set)
  const courseIdsFromTests = Array.from(new Set(Array.from(testCourseById.values()).filter((v): v is string => typeof v === "string" && v.length > 0)));
  const missingCourseIds = courseIdsFromTests.filter((id) => !courseLabelById.has(id));
  if (missingCourseIds.length > 0) {
    const moreIds = takeFirst(missingCourseIds, COURSE_ID_LIMIT);
    const { data: moreCourses, error: moreCoursesError } = await admin.from("courses").select("id, title").in("id", moreIds);
    if (!moreCoursesError && Array.isArray(moreCourses)) {
      for (const c of moreCourses as Array<{ id?: unknown; title?: unknown }>) {
        const id = typeof c.id === "string" ? c.id : null;
        if (!id) continue;
        const title = typeof c.title === "string" && c.title.trim().length ? c.title.trim() : null;
        courseLabelById.set(id, title ?? "Untitled course");
      }
    }
  }

  const orgLabel = (orgId: string | null) => {
    if (!orgId) return "No organization";
    return orgLabelById.get(orgId) ?? orgId;
  };
  const courseLabel = (courseId: string | null) => {
    if (!courseId) return "Unknown course";
    return courseLabelById.get(courseId) ?? courseId;
  };
  const testLabel = (testId: string | null) => {
    if (!testId) return "Unknown test";
    return testLabelById.get(testId) ?? testId;
  };

  const getTargetDisplay = (row: AuditLogRow) => {
    if (row.target_user_id && typeof row.target_user_id === "string") {
      const v = userDisplayById.get(row.target_user_id);
      if (v) return `${v.label}${v.role ? ` (${roleLabel(v.role)})` : ""}`;
      return row.target_user_id;
    }
    return "-";
  };

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
      const oid = (typeof row.entity_id === "string" && row.entity_id.length > 0) ? row.entity_id : getMetaString(meta, "organization_id");
      const label = orgNameFromMeta ?? orgLabel(oid);
      return `organizations (${label})`;
    }

    if (row.action === "upload_org_logo" || row.action === "remove_org_logo") {
      const oid = (typeof row.entity_id === "string" && row.entity_id.length > 0) ? row.entity_id : getMetaString(meta, "organization_id");
      return `storage.org-logos (${orgLabel(oid)})`;
    }

    if (row.action === "upload_branding_logo") return "storage.branding (global)";

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

  const getDetails = (row: AuditLogRow) => {
    const meta = asRecord(row.metadata);

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

    if (row.action === "assign_user_organization") {
      const toOrgId = getMetaString(meta, "organization_id");
      const toOrgName = getMetaString(meta, "organization_name");
      const fromOrgId = getMetaString(meta, "previous_organization_id");
      const fromText = orgLabel(fromOrgId);
      const toText = toOrgName ?? orgLabel(toOrgId);
      return `Moved org: ${fromText} → ${toText}`;
    }

    if (row.action === "enable_organization" || row.action === "disable_organization") {
      const oid =
        (typeof row.entity_id === "string" && row.entity_id.length > 0)
          ? row.entity_id
          : getMetaString(meta, "organization_id");
      const name = orgLabel(oid);
      return row.action === "enable_organization" ? `${name} is Active` : `${name} is Inactive`;
    }

    if (row.action === "create_organization") {
      const orgNameFromMeta = getMetaString(meta, "name");
      const oid = (typeof row.entity_id === "string" && row.entity_id.length > 0) ? row.entity_id : null;
      const name = orgNameFromMeta ?? orgLabel(oid);
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

    if (row.action === "upload_org_logo") return `${actorDisplay} has uploaded new logo.`;
    if (row.action === "upload_branding_logo") return `${actorDisplay} has uploaded new logo.`;
    if (row.action === "upload_user_avatar") return `${actorDisplay} has updated their avatar.`;
    if (row.action === "remove_user_avatar") return `${actorDisplay} has removed their avatar.`;

    if (row.action === "set_user_avatar_preset") {
      const preset = getMetaString(meta, "preset_name");
      return `${actorDisplay} has selected a preset avatar${preset ? ` (${preset})` : ""}.`;
    }

    if (row.action === "update_public_app_settings") return `${actorDisplay} has updated General Settings.`;

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
      const cid = typeof row.entity_id === "string" && row.entity_id.length > 0 ? row.entity_id : null;
      return `${actorDisplay} added ${courseLabel(cid)} cover image.`;
    }

    if (row.action === "upload_certificate_template") {
      const cid = typeof row.entity_id === "string" && row.entity_id.length > 0 ? row.entity_id : null;
      const fileName = getMetaString(meta, "file_name");
      return `${actorDisplay} uploaded certificate template${fileName ? ` (${fileName})` : ""} for ${courseLabel(cid)}.`;
    }

    if (row.action === "upload_course_resource") {
      const cid = typeof row.entity_id === "string" && row.entity_id.length > 0 ? row.entity_id : null;
      const fileName = getMetaString(meta, "file_name");
      return `${actorDisplay} uploaded course resource${fileName ? ` (${fileName})` : ""} to ${courseLabel(cid)}.`;
    }

    if (row.action === "create_course_test") {
      const cid = typeof row.entity_id === "string" && row.entity_id.length > 0 ? row.entity_id : null;
      const tid = getMetaString(meta, "test_id");
      const tName = tid ? testLabel(tid) : "Assessment";
      return `${actorDisplay} created ${tName} for ${courseLabel(cid)}.`;
    }

    if (row.action === "update_test_builder") {
      const tid = typeof row.entity_id === "string" && row.entity_id.length > 0 ? row.entity_id : null;
      const count = getMetaNumber(meta, "questions");
      const countText = typeof count === "number" ? ` (${count} questions)` : "";
      const cId = tid ? (testCourseById.get(tid) ?? null) : null;
      const courseText = cId ? ` for ${courseLabel(cId)}` : "";
      return `${actorDisplay} updated test builder${countText}: ${testLabel(tid)}${courseText}.`;
    }

    return "—";
  };

  const exportRows = rows.map((r) => ({
    created_at: r.created_at ?? "",
    action: r.action ?? "",
    details: getDetails(r),
    actor: r.actor_email ? `${r.actor_email}${r.actor_role ? ` (${roleLabel(r.actor_role)})` : ""}` : "",
    actor_email: r.actor_email ?? "",
    actor_role: r.actor_role ?? "",
    target: getTargetDisplay(r),
    subject: getSubjectDisplay(r),
    entity: r.entity ?? "",
    entity_id: r.entity_id ?? "",
    target_user_id: r.target_user_id ?? "",
    metadata: r.metadata ? JSON.stringify(r.metadata) : "",
  }));

  const csv = buildCsv(exportRows);
  const today = new Date().toISOString().slice(0, 10);
  const filename = `audit-logs-${today}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

