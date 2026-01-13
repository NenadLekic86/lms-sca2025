import { createAdminSupabaseClient } from "@/lib/supabase/server";

type NotificationInsert = {
  type: string;
  title: string;
  body?: string | null;
  org_id?: string | null;
  entity?: string | null;
  entity_id?: string | null;
  href?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Server-only helper to insert notifications + recipients.
 *
 * Notes:
 * - Uses service-role client (bypasses RLS) so callers must enforce permissions.
 * - Best-effort: throws only if the base notification insert fails.
 */
export async function emitNotificationToUsers(input: {
  notification: NotificationInsert;
  recipientUserIds: string[];
  actorUserId?: string | null;
}) {
  const admin = createAdminSupabaseClient();

  const recipientIds = Array.from(new Set(input.recipientUserIds))
    .map((id) => String(id))
    .filter(Boolean)
    .filter((id) => (input.actorUserId ? id !== input.actorUserId : true));

  if (recipientIds.length === 0) {
    return { notificationId: null as string | null, recipientsInserted: 0 };
  }

  const payload: Record<string, unknown> = {
    type: input.notification.type,
    title: input.notification.title,
    body: input.notification.body ?? null,
    org_id: input.notification.org_id ?? null,
    entity: input.notification.entity ?? null,
    entity_id: input.notification.entity_id ?? null,
    href: input.notification.href ?? null,
    metadata: input.notification.metadata ?? {},
  };

  const { data: inserted, error: insertError } = await admin
    .from("notifications")
    .insert(payload)
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw new Error(insertError?.message || "Failed to create notification");
  }

  const notificationId = String((inserted as { id: string }).id);

  // Insert recipient rows (per-user read state). Best-effort; if it fails we keep the base notification.
  const rows = recipientIds.map((userId) => ({
    notification_id: notificationId,
    user_id: userId,
  }));

  const { error: recipientsError } = await admin.from("notification_recipients").insert(rows);
  if (recipientsError) {
    // Don't throw; notifications are best-effort like audit logs.
    return { notificationId, recipientsInserted: 0, recipientsError: recipientsError.message };
  }

  return { notificationId, recipientsInserted: rows.length };
}

