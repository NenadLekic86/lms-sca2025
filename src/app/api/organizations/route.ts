import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { emitNotificationToUsers } from "@/lib/notifications/server";
import { createOrganizationSchema, validateSchema } from "@/lib/validations/schemas";

type OrgRow = {
  id: string;
  name?: string | null;
  slug?: string | null;
  created_at?: string | null;
  is_active?: boolean | null;
};

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const RESERVED_ORG_SLUGS = new Set<string>([
  // General app / common reserved paths
  "admin",
  "system",
  "api",
  "login",
  "register",
  "reset-password",
  "forgot-password",
  "support",
  "company",
  "legal",
  "unauthorized",
  "org",
  "organizations",
  "dashboard",
  "settings",
  "reports",
  "users",
  "courses",
  "tests",
  "certificates",
]);

export async function GET(request: NextRequest) {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["super_admin", "system_admin"].includes(caller.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const includeCounts = new URL(request.url).searchParams.get("include_counts") === "1";

  const admin = createAdminSupabaseClient();
  const { data, error: loadError } = await admin
    .from("organizations")
    .select("*")
    .order("created_at", { ascending: false });

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }

  const orgs = (Array.isArray(data) ? data : []) as OrgRow[];

  if (!includeCounts) {
    return NextResponse.json({ organizations: orgs });
  }

  // Compute counts (best-effort, admin-only). If a table is missing, surface a soft error in response.
  let usersCountError: string | null = null;
  let coursesCountError: string | null = null;
  let certificatesCountError: string | null = null;

  const usersByOrg: Record<string, number> = {};
  const usersActiveByOrg: Record<string, number> = {};
  const usersDisabledByOrg: Record<string, number> = {};
  const coursesByOrg: Record<string, number> = {};
  const certificatesByOrg: Record<string, number> = {};

  try {
    const { data: usersData, error: usersError } = await admin
      .from("users")
      .select("organization_id, is_active");
    if (usersError) {
      usersCountError = usersError.message;
    } else {
      for (const row of (Array.isArray(usersData) ? usersData : []) as Array<{ organization_id?: string | null; is_active?: boolean | null }>) {
        const orgId = row.organization_id;
        if (!orgId) continue;
        usersByOrg[orgId] = (usersByOrg[orgId] || 0) + 1;

        // Treat null as active (default true in DB); only explicit false is "disabled"
        if (row.is_active === false) {
          usersDisabledByOrg[orgId] = (usersDisabledByOrg[orgId] || 0) + 1;
        } else {
          usersActiveByOrg[orgId] = (usersActiveByOrg[orgId] || 0) + 1;
        }
      }
    }
  } catch (e) {
    usersCountError = e instanceof Error ? e.message : "Failed to load users";
  }

  try {
    const { data: coursesData, error: coursesError } = await admin
      .from("courses")
      .select("organization_id");
    if (coursesError) {
      coursesCountError = coursesError.message;
    } else {
      for (const row of (Array.isArray(coursesData) ? coursesData : []) as Array<{ organization_id?: string | null }>) {
        const orgId = row.organization_id;
        if (!orgId) continue;
        coursesByOrg[orgId] = (coursesByOrg[orgId] || 0) + 1;
      }
    }
  } catch (e) {
    coursesCountError = e instanceof Error ? e.message : "Failed to load courses";
  }

  try {
    const { data: certData, error: certError } = await admin
      .from("certificates")
      .select("organization_id");
    if (certError) {
      certificatesCountError = certError.message;
    } else {
      for (const row of (Array.isArray(certData) ? certData : []) as Array<{ organization_id?: string | null }>) {
        const orgId = row.organization_id;
        if (!orgId) continue;
        certificatesByOrg[orgId] = (certificatesByOrg[orgId] || 0) + 1;
      }
    }
  } catch (e) {
    certificatesCountError = e instanceof Error ? e.message : "Failed to load certificates";
  }

  const enriched = orgs.map((o) => ({
    ...o,
    users_count: usersByOrg[o.id] || 0,
    users_active_count: usersActiveByOrg[o.id] || 0,
    users_disabled_count: usersDisabledByOrg[o.id] || 0,
    courses_count: coursesByOrg[o.id] || 0,
    certificates_count: certificatesByOrg[o.id] || 0,
  }));

  return NextResponse.json({
    organizations: enriched,
    counts_errors: {
      users: usersCountError,
      courses: coursesCountError,
      certificates: certificatesCountError,
    },
  });
}

export async function POST(request: NextRequest) {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["super_admin", "system_admin"].includes(caller.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Parse and validate with zod
  const body = await request.json().catch(() => null);
  const validation = validateSchema(createOrganizationSchema, body);
  
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { name, slug: slugInput } = validation.data;
  const explicitSlug = typeof slugInput === "string" && slugInput.trim().length > 0;
  let baseSlug = slugify(explicitSlug ? String(slugInput) : name);
  if (!baseSlug) {
    return NextResponse.json({ error: "Organization slug is required (could not be derived from name)." }, { status: 400 });
  }
  if (RESERVED_ORG_SLUGS.has(baseSlug)) {
    if (explicitSlug) {
      return NextResponse.json({ error: `Slug "${baseSlug}" is reserved. Please choose another slug.` }, { status: 400 });
    }
    baseSlug = `${baseSlug}-org`;
  }

  const admin = createAdminSupabaseClient();

  // Collision-safe create:
  // - If user provided a slug, do NOT mutate it on conflict (return 409).
  // - If slug was auto-generated, retry with -2, -3, ... suffix.
  let inserted: OrgRow | null = null;
  let finalSlug = baseSlug;
  for (let attempt = 0; attempt < 30; attempt++) {
    finalSlug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`; // -2, -3, ...
    const { data: row, error: insertError } = await admin
      .from("organizations")
      .insert({ name, slug: finalSlug })
      .select("*")
      .single();

    if (!insertError && row) {
      inserted = row as OrgRow;
      break;
    }

    const msg = insertError?.message ?? "";
    const conflict = /duplicate key|unique constraint|already exists/i.test(msg);
    if (conflict) {
      if (explicitSlug) {
        return NextResponse.json(
          { error: `Slug "${baseSlug}" is already taken. Please choose another slug.` },
          { status: 409 }
        );
      }
      // retry
      continue;
    }

    return NextResponse.json({ error: msg || "Failed to create organization" }, { status: 500 });
  }

  if (!inserted) {
    return NextResponse.json(
      { error: "Failed to create organization (could not generate a unique slug). Please try a different name." },
      { status: 500 }
    );
  }

  // Best-effort notifications (super_admin + system_admin)
  try {
    const insertedIdRaw = (inserted as Record<string, unknown>).id;
    const insertedId = typeof insertedIdRaw === "string" ? insertedIdRaw : null;

    const { data: adminUsers } = await admin
      .from("users")
      .select("id")
      .in("role", ["super_admin", "system_admin"])
      .or("is_active.is.null,is_active.eq.true");

    const recipientIds = (Array.isArray(adminUsers) ? adminUsers : [])
      .map((r: { id?: string | null }) => r.id)
      .filter((v): v is string => typeof v === "string");

    await emitNotificationToUsers({
      actorUserId: caller.id,
      recipientUserIds: recipientIds,
      notification: {
        type: "organization_created",
        title: "New organization created",
        body: `${name} was created`,
        org_id: insertedId,
        entity: "organizations",
        entity_id: insertedId,
        href: null,
        metadata: { name, slug: finalSlug },
      },
    });
  } catch {
    // ignore
  }

  // Best-effort audit log
  try {
    const insertedIdRaw = (inserted as Record<string, unknown>).id;
    const insertedId = typeof insertedIdRaw === "string" ? insertedIdRaw : null;
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "create_organization",
      entity: "organizations",
      entity_id: insertedId,
      metadata: { name, slug: finalSlug },
    });
  } catch {
    // ignore
  }

  return NextResponse.json({ organization: inserted }, { status: 201 });
}
