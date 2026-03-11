import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";

type RateState = { hits: number[] };
function getRateMap(): Map<string, RateState> {
  const g = globalThis as unknown as { __meOrgRateMap?: Map<string, RateState> };
  if (!g.__meOrgRateMap) g.__meOrgRateMap = new Map();
  return g.__meOrgRateMap;
}

function rateLimit(key: string, opts: { windowMs: number; max: number }): boolean {
  const now = Date.now();
  const map = getRateMap();
  const state = map.get(key) ?? { hits: [] };
  state.hits = state.hits.filter((t) => now - t < opts.windowMs);
  if (state.hits.length >= opts.max) {
    map.set(key, state);
    return false;
  }
  state.hits.push(now);
  map.set(key, state);
  return true;
}

const bodySchema = z
  .object({
    name: z.string().trim().min(2, "Organization name must be at least 2 characters").max(120, "Organization name is too long"),
  })
  .strict();

function normalizeOrgName(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

/**
 * PATCH /api/me/organization
 * Allows an organization_admin to rename their own organization.
 */
export async function PATCH(request: NextRequest) {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) {
    await logApiEvent({ request, caller: null, outcome: "error", status: 401, code: "UNAUTHORIZED", publicMessage: "Unauthorized" });
    return apiError("UNAUTHORIZED", "Unauthorized", { status: 401 });
  }

  if (caller.role !== "organization_admin" || !caller.organization_id) {
    await logApiEvent({ request, caller, outcome: "error", status: 403, code: "FORBIDDEN", publicMessage: "Forbidden" });
    return apiError("FORBIDDEN", "Forbidden", { status: 403 });
  }

  // Basic rate limit per user (prevents spam-clicking).
  const key = `orgname:${caller.id}`;
  if (!rateLimit(key, { windowMs: 10_000, max: 5 })) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 429,
      code: "RATE_LIMITED",
      publicMessage: "Too many requests. Please wait a moment and try again.",
      internalMessage: `Rate limit hit for key=${key}`,
    });
    return apiError("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", { status: 429 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: "Invalid request." });
    return apiError("VALIDATION_ERROR", "Invalid request.", { status: 400 });
  }

  const name = normalizeOrgName(parsed.data.name);

  const admin = createAdminSupabaseClient();

  // Ensure org exists and is the caller's org (authoritative).
  const { data: orgRow, error: orgErr } = await admin
    .from("organizations")
    .select("id, name, slug, is_active")
    .eq("id", caller.organization_id)
    .single();
  if (orgErr || !orgRow?.id) {
    await logApiEvent({ request, caller, outcome: "error", status: 404, code: "NOT_FOUND", publicMessage: "Organization not found." });
    return apiError("NOT_FOUND", "Organization not found.", { status: 404 });
  }

  if ((orgRow as { is_active?: unknown }).is_active === false) {
    await logApiEvent({ request, caller, outcome: "error", status: 409, code: "CONFLICT", publicMessage: "Organization is disabled." });
    return apiError("CONFLICT", "Organization is disabled.", { status: 409 });
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
    .eq("id", caller.organization_id)
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
      metadata: { previous_name: prevName, next_name: updated.name },
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

