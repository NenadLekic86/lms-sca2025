import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { updateProfileSchema, validateSchema } from "@/lib/validations/schemas";

type MeResponse = {
  user: {
    id: string;
    email: string;
    role: string;
    organization_id: string | null;
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

export async function GET() {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({
    user: {
      id: caller.id,
      email: caller.email,
      role: caller.role,
      organization_id: caller.organization_id,
      full_name: (caller.full_name ?? null) as string | null,
      avatar_url: ((caller as { avatar_url?: unknown } | null)?.avatar_url ?? null) as string | null,
    },
  } satisfies MeResponse);
}

export async function PATCH(request: NextRequest) {
  // Safety net: prevent runaway clients (e.g. DevTools snippet / extension) from spamming PATCH.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local";
  const key = `patch:${ip}`;
  if (!rateLimit(key, { windowMs: 10_000, max: 10 })) {
    return NextResponse.json(
      { error: "Too many profile update requests. Please stop any repeated calls and try again." },
      { status: 429 }
    );
  }

  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Parse and validate with zod
  const body = await request.json().catch(() => null);
  const validation = validateSchema(updateProfileSchema, body);
  
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { full_name } = validation.data;

  if (full_name === undefined) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
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
    return NextResponse.json(
      {
        error:
          'Database is missing column "users.full_name". Add it in Supabase (SQL Editor): alter table public.users add column if not exists full_name text;',
      },
      { status: 500 }
    );
  }

  if (attempt.error && !permissionDenied) {
    return NextResponse.json({ error: attempt.error.message || "Failed to update profile" }, { status: 500 });
  }

  if (!attempt.error && attempt.data) {
    // Return the value as stored (single source of truth)
    const avatarRaw = (attempt.data as { avatar_url?: unknown }).avatar_url;
    const avatarUrl = typeof avatarRaw === "string" ? avatarRaw : null;
    return NextResponse.json({
      user: {
        id: attempt.data.id,
        email: attempt.data.email,
        role: attempt.data.role,
        organization_id: attempt.data.organization_id,
        full_name: attempt.data.full_name ?? null,
        avatar_url: avatarUrl,
      },
    } satisfies MeResponse);
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
      return NextResponse.json({ error: updateError?.message || "Failed to update profile" }, { status: 500 });
    }

    // Extra safety: verify persisted value (prevents false "Saved" UX).
    const { data: verify, error: verifyError } = await admin
      .from("users")
      .select("full_name")
      .eq("id", caller.id)
      .single();

    if (verifyError) {
      return NextResponse.json(
        { error: `Profile updated but failed to verify persistence: ${verifyError.message}` },
        { status: 500 }
      );
    }

    const stored = (verify as { full_name?: unknown } | null)?.full_name;
    const storedName = typeof stored === "string" ? stored : stored === null ? null : null;
    const expected = full_name ?? null;

    if (expected !== storedName) {
      return NextResponse.json(
        {
          error:
            "Profile save could not be verified. Please refresh and try again. (Stored value mismatch)",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
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
    } satisfies MeResponse);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to update profile" },
      { status: 500 }
    );
  }
}
