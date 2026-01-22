import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { emitNotificationToUsers } from "@/lib/notifications/server";
import { createOrganizationSchema, validateSchema } from "@/lib/validations/schemas";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

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
  if (!["super_admin", "system_admin"].includes(caller.role)) {
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const includeCounts = new URL(request.url).searchParams.get("include_counts") === "1";

  const admin = createAdminSupabaseClient();
  const { data, error: loadError } = await admin
    .from("organizations")
    .select("*")
    .order("created_at", { ascending: false });

  if (loadError) {
    return apiError("INTERNAL", "Failed to load organizations.", { status: 500 });
  }

  const orgs = (Array.isArray(data) ? data : []) as OrgRow[];

  if (!includeCounts) {
    return apiOk({ organizations: orgs }, { status: 200 });
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

  return apiOk(
    {
      organizations: enriched,
      counts_errors: {
        users: usersCountError,
        courses: coursesCountError,
        certificates: certificatesCountError,
      },
    },
    { status: 200 }
  );
}

export async function POST(request: NextRequest) {
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
  if (!["super_admin", "system_admin"].includes(caller.role)) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 403,
      code: "FORBIDDEN",
      publicMessage: "Forbidden",
      internalMessage: "only super_admin/system_admin can create organizations",
    });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  // Parse and validate with zod
  const body = await request.json().catch(() => null);
  const validation = validateSchema(createOrganizationSchema, body);
  
  if (!validation.success) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 400,
      code: "VALIDATION_ERROR",
      publicMessage: validation.error,
    });
    return apiError("VALIDATION_ERROR", validation.error, { status: 400 });
  }

  const { name, slug: slugInput } = validation.data;
  const explicitSlug = typeof slugInput === "string" && slugInput.trim().length > 0;
  let baseSlug = slugify(explicitSlug ? String(slugInput) : name);
  if (!baseSlug) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 400,
      code: "VALIDATION_ERROR",
      publicMessage: "Organization slug is required.",
      internalMessage: "could not derive slug from name",
    });
    return apiError("VALIDATION_ERROR", "Organization slug is required.", { status: 400 });
  }
  if (RESERVED_ORG_SLUGS.has(baseSlug)) {
    if (explicitSlug) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 400,
        code: "VALIDATION_ERROR",
        publicMessage: `Slug "${baseSlug}" is reserved. Please choose another slug.`,
      });
      return apiError("VALIDATION_ERROR", `Slug "${baseSlug}" is reserved. Please choose another slug.`, { status: 400 });
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
        await logApiEvent({
          request,
          caller,
          outcome: "error",
          status: 409,
          code: "CONFLICT",
          publicMessage: `Slug "${baseSlug}" is already taken. Please choose another slug.`,
          internalMessage: msg,
        });
        return apiError("CONFLICT", `Slug "${baseSlug}" is already taken. Please choose another slug.`, { status: 409 });
      }
      // retry
      continue;
    }

    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to create organization.",
      internalMessage: msg || "unknown insert error",
    });
    return apiError("INTERNAL", "Failed to create organization.", { status: 500 });
  }

  if (!inserted) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to create organization.",
      internalMessage: "could not generate unique slug",
    });
    return apiError("INTERNAL", "Failed to create organization.", { status: 500 });
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

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 201,
    publicMessage: "Organization created.",
    details: { organization_id: inserted.id, slug: finalSlug },
  });

  return apiOk({ organization: inserted }, { status: 201, message: "Organization created." });
}
