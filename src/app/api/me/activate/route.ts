import { NextResponse } from "next/server";
import { createAdminSupabaseClient, createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { emitNotificationToUsers } from "@/lib/notifications/server";

/**
 * POST /api/me/activate
 *
 * Marks the current user as "active" in public.users onboarding state.
 *
 * Rules:
 * - Only flips onboarding_status pending -> active
 * - Never activates disabled users (is_active = false)
 * - Idempotent: if already active, returns success
 */
export async function POST() {
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Disabled users should never be activated by onboarding.
  if (caller.is_active === false) {
    return NextResponse.json({ error: "Forbidden: account disabled" }, { status: 403 });
  }

  const supabase = await createServerSupabaseClient();

  // Best-effort, idempotent update: only update if currently pending
  const { data, error: updateError } = await supabase
    .from("users")
    .update({
      onboarding_status: "active",
      activated_at: new Date().toISOString(),
    })
    .eq("id", caller.id)
    .eq("onboarding_status", "pending")
    .select("id, onboarding_status, activated_at")
    .single();

  // If no row matched, .single() may error. Treat as already-active / not-pending.
  if (updateError) {
    const msg = updateError.message || "";
    const looksLikeNoRow =
      /0 rows|no rows|json object requested, multiple \\(or no\\) rows returned/i.test(msg);
    if (!looksLikeNoRow) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
  }

  // Notifications: only when we actually flipped pending -> active (i.e., data returned).
  if (data) {
    try {
      const admin = createAdminSupabaseClient();

      // Helper to fetch active user ids with filters.
      const activeFilter = "is_active.is.null,is_active.eq.true";

      if (caller.role === "member") {
        const orgId = caller.organization_id;
        if (orgId) {
          const { data: orgAdmins } = await admin
            .from("users")
            .select("id")
            .eq("role", "organization_admin")
            .eq("organization_id", orgId)
            .or(activeFilter);

          const recipientIds = (Array.isArray(orgAdmins) ? orgAdmins : [])
            .map((r: { id?: string | null }) => r.id)
            .filter((v): v is string => typeof v === "string");

          await emitNotificationToUsers({
            actorUserId: caller.id,
            recipientUserIds: recipientIds,
            notification: {
              type: "member_activated",
              title: "New member joined",
              body: `${caller.email} became active`,
              org_id: orgId,
              entity: "users",
              entity_id: caller.id,
              href: null,
              metadata: { email: caller.email, role: caller.role },
            },
          });
        }
      }

      if (caller.role === "organization_admin") {
        const { data: admins } = await admin
          .from("users")
          .select("id")
          .in("role", ["super_admin", "system_admin"])
          .or(activeFilter);

        const recipientIds = (Array.isArray(admins) ? admins : [])
          .map((r: { id?: string | null }) => r.id)
          .filter((v): v is string => typeof v === "string");

        await emitNotificationToUsers({
          actorUserId: caller.id,
          recipientUserIds: recipientIds,
          notification: {
            type: "org_admin_activated",
            title: "New organization admin activated",
            body: `${caller.email} became active`,
            org_id: caller.organization_id ?? null,
            entity: "users",
            entity_id: caller.id,
            href: null,
            metadata: { email: caller.email, role: caller.role },
          },
        });
      }
    } catch {
      // ignore
    }
  }

  return NextResponse.json(
    {
      message: "Activation recorded",
      user: data ?? null,
    },
    { status: 200 }
  );
}


