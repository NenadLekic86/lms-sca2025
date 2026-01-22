import { NextRequest } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { updateProfileSchema, validateSchema } from "@/lib/validations/schemas";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

type MeResponse = {
  user: {
    id: string;
    email: string;
    role: string;
    organization_id: string | null;
    organization_name?: string | null;
    organization_slug?: string | null;
    full_name: string | null;
    avatar_url?: string | null;
  };
};

type RateState = { hits: number[] };
function getRateMap(): Map<string, RateState> {
  const g = globalThis as unknown as { __meRateMap?: Map<string, RateState> };
  if (!g.__meRateMap) g.__meRateMap = new Map();
  return g.__meRateMap;
}

function rateLimit(key: string, opts: { windowMs: number; max: number }): boolean {
  const now = Date.now();
  const map = getRateMap();
  const state = map.get(key) ?? { hits: [] };
  // prune old
  state.hits = state.hits.filter((t) => now - t < opts.windowMs);
  if (state.hits.length >= opts.max) {
    map.set(key, state);
    return false;
  }
  state.hits.push(now);
  map.set(key, state);
  return true;
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

  // Best-effort org display fields (avoid relying on RLS by using admin client,
  // but only for the caller's own org id).
  let organization_name: string | null = null;
  let organization_slug: string | null = null;
  if (caller.organization_id) {
    try {
      const admin = createAdminSupabaseClient();
      const { data: org, error: orgErr } = await admin
        .from("organizations")
        .select("name, slug")
        .eq("id", caller.organization_id)
        .maybeSingle();
      if (!orgErr && org) {
        const rawName = (org as { name?: unknown }).name;
        const rawSlug = (org as { slug?: unknown }).slug;
        organization_name = typeof rawName === "string" && rawName.trim().length ? rawName.trim() : null;
        organization_slug = typeof rawSlug === "string" && rawSlug.trim().length ? rawSlug.trim() : null;
      }
    } catch {
      // ignore (best-effort)
    }
  }

  return apiOk(
    {
      user: {
        id: caller.id,
        email: caller.email,
        role: caller.role,
        organization_id: caller.organization_id,
        organization_name,
        organization_slug,
        full_name: (caller.full_name ?? null) as string | null,
        avatar_url: ((caller as { avatar_url?: unknown } | null)?.avatar_url ?? null) as string | null,
      },
    } satisfies MeResponse,
    { status: 200 }
  );
}

export async function PATCH(request: NextRequest) {
  // Safety net: prevent runaway clients (e.g. DevTools snippet / extension) from spamming PATCH.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local";
  const key = `patch:${ip}`;
  if (!rateLimit(key, { windowMs: 10_000, max: 10 })) {
    await logApiEvent({
      request,
      caller: null,
      outcome: "error",
      status: 429,
      code: "RATE_LIMITED",
      publicMessage: "Too many profile update requests. Please stop any repeated calls and try again.",
      internalMessage: `Rate limit hit for key=${key}`,
    });
    return apiError(
      "RATE_LIMITED",
      "Too many profile update requests. Please stop any repeated calls and try again.",
      { status: 429 }
    );
  }

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

  // Parse and validate with zod
  const body = await request.json().catch(() => null);
  const validation = validateSchema(updateProfileSchema, body);
  
  if (!validation.success) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: validation.error });
    return apiError("VALIDATION_ERROR", validation.error, { status: 400 });
  }

  const { full_name } = validation.data;

  if (full_name === undefined) {
    await logApiEvent({ request, caller, outcome: "error", status: 400, code: "VALIDATION_ERROR", publicMessage: "Nothing to update." });
    return apiError("VALIDATION_ERROR", "Nothing to update.", { status: 400 });
  }

  // Prefer updating with the user's session (RLS-friendly). If RLS blocks this,
  // fall back to admin client (server-side only) while still enforcing caller.id.
  const server = await createServerSupabaseClient();
  const attempt = await server
    .from("users")
    .update({ full_name: full_name })
    .eq("id", caller.id)
    .select("id, email, role, organization_id, full_name, avatar_url")
    .single();

  const permissionDenied =
    !!attempt.error &&
    /permission denied|row level security|rls/i.test(attempt.error.message || "");

  const missingColumn =
    !!attempt.error &&
    /full_name/i.test(attempt.error.message || "") &&
    (/schema cache/i.test(attempt.error.message || "") ||
      /column/i.test(attempt.error.message || "") ||
      /does not exist/i.test(attempt.error.message || ""));

  if (missingColumn) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Profile updates are temporarily unavailable. Please contact support.",
      internalMessage:
        'Database is missing column "users.full_name". Add it in Supabase: alter table public.users add column if not exists full_name text;',
    });
    return apiError("INTERNAL", "Profile updates are temporarily unavailable. Please contact support.", { status: 500 });
  }

  if (attempt.error && !permissionDenied) {
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to update profile.",
      internalMessage: attempt.error.message || "unknown update error",
    });
    return apiError("INTERNAL", "Failed to update profile.", { status: 500 });
  }

  if (!attempt.error && attempt.data) {
    // Return the value as stored (single source of truth)
    const avatarRaw = (attempt.data as { avatar_url?: unknown }).avatar_url;
    const avatarUrl = typeof avatarRaw === "string" ? avatarRaw : null;
    await logApiEvent({ request, caller, outcome: "success", status: 200, publicMessage: "Profile saved." });
    return apiOk(
      {
        user: {
          id: attempt.data.id,
          email: attempt.data.email,
          role: attempt.data.role,
          organization_id: attempt.data.organization_id,
          full_name: attempt.data.full_name ?? null,
          avatar_url: avatarUrl,
        },
      } satisfies MeResponse,
      { status: 200, message: "Profile saved." }
    );
  }

  // Fallback: admin client update (bypasses RLS, but only for caller.id)
  try {
    const admin = createAdminSupabaseClient();
    const { data, error: updateError } = await admin
      .from("users")
      .update({ full_name: full_name })
      .eq("id", caller.id)
      .select("id, email, role, organization_id, full_name, avatar_url")
      .single();

    if (updateError || !data) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Failed to update profile.",
        internalMessage: updateError?.message || "no updated row returned",
      });
      return apiError("INTERNAL", "Failed to update profile.", { status: 500 });
    }

    // Extra safety: verify persisted value (prevents false "Saved" UX).
    const { data: verify, error: verifyError } = await admin
      .from("users")
      .select("full_name")
      .eq("id", caller.id)
      .single();

    if (verifyError) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Failed to verify profile update.",
        internalMessage: verifyError.message,
      });
      return apiError("INTERNAL", "Failed to verify profile update.", { status: 500 });
    }

    const stored = (verify as { full_name?: unknown } | null)?.full_name;
    const storedName = typeof stored === "string" ? stored : stored === null ? null : null;
    const expected = full_name ?? null;

    if (expected !== storedName) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Profile save could not be verified. Please refresh and try again.",
        internalMessage: "stored value mismatch",
      });
      return apiError("INTERNAL", "Profile save could not be verified. Please refresh and try again.", { status: 500 });
    }

    await logApiEvent({ request, caller, outcome: "success", status: 200, publicMessage: "Profile saved." });
    return apiOk(
      {
        user: {
          id: data.id,
          email: data.email,
          role: data.role,
          organization_id: data.organization_id,
          full_name: storedName,
          avatar_url: (() => {
            const raw = (data as { avatar_url?: unknown }).avatar_url;
            return typeof raw === "string" ? raw : null;
          })(),
        },
      } satisfies MeResponse,
      { status: 200, message: "Profile saved." }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to update profile";
    await logApiEvent({
      request,
      caller,
      outcome: "error",
      status: 500,
      code: "INTERNAL",
      publicMessage: "Failed to update profile.",
      internalMessage: msg,
    });
    return apiError("INTERNAL", "Failed to update profile.", { status: 500 });
  }
}
