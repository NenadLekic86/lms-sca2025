import { NextResponse } from "next/server";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

type NotificationRow = {
  id: string;
  created_at: string;
  type: string;
  title: string;
  body: string | null;
  org_id: string | null;
  entity: string | null;
  entity_id: string | null;
  href: string | null;
  metadata: Record<string, unknown> | null;
};

type RecipientRow = {
  notification_id: string;
  read_at: string | null;
  created_at: string;
  // Depending on FK introspection, Supabase may return an object or an array.
  notifications?: NotificationRow | NotificationRow[] | null;
};

export async function GET() {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createServerSupabaseClient();

  const [unreadRes, listRes] = await Promise.all([
    supabase
      .from("notification_recipients")
      .select("notification_id", { count: "exact", head: true })
      .eq("user_id", caller.id)
      .is("read_at", null),
    supabase
      .from("notification_recipients")
      .select(
        "notification_id, read_at, created_at, notifications(id, created_at, type, title, body, org_id, entity, entity_id, href, metadata)"
      )
      .eq("user_id", caller.id)
      .order("created_at", { ascending: false })
      .limit(30),
  ]);

  if (unreadRes.error) {
    return NextResponse.json({ error: unreadRes.error.message }, { status: 500 });
  }
  if (listRes.error) {
    return NextResponse.json({ error: listRes.error.message }, { status: 500 });
  }

  const unreadCount = unreadRes.count ?? 0;

  const rows = (Array.isArray(listRes.data) ? listRes.data : []) as RecipientRow[];
  const notifications = rows
    .map((r) => {
      const embedded = r.notifications ?? null;
      const n = (Array.isArray(embedded) ? embedded[0] : embedded) as NotificationRow | null;
      if (!n) return null;
      return {
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        created_at: n.created_at,
        org_id: n.org_id,
        entity: n.entity,
        entity_id: n.entity_id,
        href: n.href,
        metadata: n.metadata ?? {},
        read_at: r.read_at ?? null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  return NextResponse.json({ unreadCount, notifications }, { status: 200 });
}

