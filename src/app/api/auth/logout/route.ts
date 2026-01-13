import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST() {
  // Best-effort: Supabase sign out (also updates cookies via @supabase/ssr)
  try {
    const supabase = await createServerSupabaseClient();
    await supabase.auth.signOut();
  } catch {
    // ignore
  }

  // Hard-clear any lingering Supabase cookies on this domain.
  const cookieStore = await cookies();
  for (const c of cookieStore.getAll()) {
    if (c.name.startsWith("sb-")) {
      cookieStore.set(c.name, "", { path: "/", maxAge: 0 });
    }
  }

  return NextResponse.json({ message: "Logged out" }, { status: 200 });
}


