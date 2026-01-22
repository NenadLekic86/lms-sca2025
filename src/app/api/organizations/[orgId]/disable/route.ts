import { NextRequest } from "next/server";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { apiError, apiOk } from "@/lib/api/response";
import { logApiEvent } from "@/lib/audit/apiEvents";

/**
 * PATCH /api/organizations/[orgId]/disable
 * Disables an organization by setting public.organizations.is_active = false.
 *
 * Also cascade-disables all users in that organization (so they cannot log in).
 *
 * Permissions:
 * - super_admin, system_admin: allowed
 * - others: forbidden
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
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
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 403,
        code: "FORBIDDEN",
        publicMessage: "Forbidden",
      });
      return apiError("FORBIDDEN", "Forbidden", { status: 403 });
    }

    const admin = createAdminSupabaseClient();

    // Ensure org exists
    const { data: org, error: orgError } = await admin
      .from("organizations")
      .select("id, is_active")
      .eq("id", orgId)
      .single();

    if (orgError || !org) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 404,
        code: "NOT_FOUND",
        publicMessage: "Organization not found.",
      });
      return apiError("NOT_FOUND", "Organization not found.", { status: 404 });
    }

    // 1) Disable org
    const { error: updateOrgError } = await admin
      .from("organizations")
      .update({ is_active: false })
      .eq("id", orgId);

    if (updateOrgError) {
      await logApiEvent({
        request,
        caller,
        outcome: "error",
        status: 500,
        code: "INTERNAL",
        publicMessage: "Failed to disable organization.",
        internalMessage: updateOrgError.message,
      });
      return apiError("INTERNAL", "Failed to disable organization.", { status: 500 });
    }

    // 2) Cascade-disable users in org (best-effort but we do return error if this fails)
    // IMPORTANT: preserve manually-disabled users.
    // Only users who were active (is_active true or null) get disabled_by_org=true.
    // This ensures org re-enable only restores users that were disabled due to org disable.
    const cascadeWithReason = await admin
      .from("users")
      .update({ is_active: false, disabled_by_org: true } as unknown as Record<string, unknown>)
      .eq("organization_id", orgId)
      .or("is_active.is.null,is_active.eq.true");

    if (cascadeWithReason.error) {
      const msg = cascadeWithReason.error.message ?? "";
      const missingColumn =
        /disabled_by_org/i.test(msg) && (/column/i.test(msg) || /does not exist/i.test(msg) || /schema cache/i.test(msg));

      if (missingColumn) {
        const cascadeFallback = await admin
          .from("users")
          .update({ is_active: false })
          .eq("organization_id", orgId)
          .or("is_active.is.null,is_active.eq.true");

        if (cascadeFallback.error) {
          await logApiEvent({
            request,
            caller,
            outcome: "error",
            status: 500,
            code: "INTERNAL",
            publicMessage: "Failed to disable organization users.",
            internalMessage: cascadeFallback.error.message,
          });
          return apiError("INTERNAL", "Failed to disable organization users.", { status: 500 });
        }
      } else {
        await logApiEvent({
          request,
          caller,
          outcome: "error",
          status: 500,
          code: "INTERNAL",
          publicMessage: "Failed to disable organization users.",
          internalMessage: msg || "unknown cascade error",
        });
        return apiError("INTERNAL", "Failed to disable organization users.", { status: 500 });
      }
    }

    // Best-effort audit log
    try {
      await admin.from("audit_logs").insert({
        actor_user_id: caller.id,
        actor_email: caller.email,
        actor_role: caller.role,
        action: "disable_organization",
        entity: "organizations",
        entity_id: orgId,
        metadata: {
          organization_id: orgId,
          previous_is_active: (org as { is_active?: unknown }).is_active ?? null,
        },
      });
    } catch {
      // ignore
    }

    await logApiEvent({
      request,
      caller,
      outcome: "success",
      status: 200,
      publicMessage: "Organization disabled.",
      details: { organization_id: orgId },
    });

    return apiOk({ organization_id: orgId }, { status: 200, message: "Organization disabled." });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    try {
      const { user: caller } = await getServerUser();
      if (caller) {
        await logApiEvent({
          request,
          caller,
          outcome: "error",
          status: 500,
          code: "INTERNAL",
          publicMessage: "Internal server error.",
          internalMessage: msg,
        });
      }
    } catch {
      // ignore
    }
    return apiError("INTERNAL", "Internal server error.", { status: 500 });
  }
}


