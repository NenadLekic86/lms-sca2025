import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    name: z.string().trim().min(2, "Organization name must be at least 2 characters").max(120, "Organization name is too long"),
  })
  .strict();

function normalizeOrgName(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

/**
 * PATCH /api/organizations/[orgId]/name
 * Allows super_admin + system_admin to rename any organization.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await params;

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
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: "Invalid request." });
    return apiError("VALIDATION_ERROR", "Invalid request.", { status: 400 });
  }

  const name = normalizeOrgName(parsed.data.name);
  const admin = createAdminSupabaseClient();

  const { data: orgRow, error: orgErr } = await admin
    .from("organizations")
    .select("id, name, slug, is_active")
    .eq("id", orgId)
    .single();
  if (orgErr || !orgRow?.id) {
    await logApiEvent({ request, caller, outcome: "error", status: 404, code: "NOT_FOUND", publicMessage: "Organization not found." });
    return apiError("NOT_FOUND", "Organization not found.", { status: 404 });
  }

  const prevName = typeof (orgRow as { name?: unknown }).name === "string" ? String((orgRow as { name: string }).name) : null;
  if (prevName && prevName.trim() === name) {
    return apiOk(
      { organization: { id: orgRow.id, name: prevName, slug: (orgRow as { slug?: string | null }).slug ?? null } },
      { status: 200, message: "Organization name is unchanged." }
    );
  }

  const { data: updated, error: updateErr } = await admin
    .from("organizations")
    .update({ name })
    .eq("id", orgId)
    .select("id, name, slug")
    .single();

  if (updateErr || !updated) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to update organization name.",
      internalMessage: updateErr?.message ?? "no row returned",
    });
    return apiError("INTERNAL", "Failed to update organization name.", { status: 500 });
  }

  // Best-effort audit log
  try {
    await admin.from("audit_logs").insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: "update_organization_name",
      entity: "organizations",
      entity_id: updated.id,
      metadata: { previous_name: prevName, next_name: updated.name, organization_id: updated.id },
    });
  } catch {
    // ignore
  }

  await logApiEvent({
    request,
    caller,
    outcome: "success",
    status: 200,
    publicMessage: "Organization name updated.",
    details: { organization_id: updated.id },
  });

  return apiOk({ organization: updated }, { status: 200, message: "Organization name updated." });
}

