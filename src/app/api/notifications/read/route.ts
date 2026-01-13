import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Body = { notification_id?: unknown; all?: unknown };

function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export async function POST(request: NextRequest) {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Body;
  const all = body.all === true;
  const notificationId = body.notification_id;

  if (!all && !isUuid(notificationId)) {
    return NextResponse.json({ error: "Provide { all: true } or a valid notification_id" }, { status: 400 });
  }

  const supabase = await createServerSupabaseClient();
  const now = new Date().toISOString();

  const updateQuery = supabase
    .from("notification_recipients")
    .update({ read_at: now })
    .eq("user_id", caller.id);

  const { error: updateError } = all
    ? await updateQuery.is("read_at", null)
    : await updateQuery.eq("notification_id", notificationId as string);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

