import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { validateSchema } from "@/lib/validations/schemas";

export const runtime = "nodejs";

const upsertProgressSchema = z.object({
  item_type: z.enum(["resource", "video"]),
  item_id: z.string().uuid(),
  completed: z.boolean(),
});

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createServerSupabaseClient();

  const { data, error: loadError } = await supabase
    .from("course_content_progress")
    .select("id, course_id, item_type, item_id, completed_at, updated_at")
    .eq("course_id", id)
    .eq("user_id", caller.id);

  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });

  return NextResponse.json({ progress: Array.isArray(data) ? data : [] }, { status: 200 });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!caller.organization_id) return NextResponse.json({ error: "Missing organization" }, { status: 400 });

  const body = await request.json().catch(() => null);
  const validation = validateSchema(upsertProgressSchema, body);
  if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });

  const { item_type, item_id, completed } = validation.data;

  // Use session client so RLS enforces:
  // - user can only write their own progress
  // - user must be enrolled (active) in the course
  const supabase = await createServerSupabaseClient();

  const now = new Date().toISOString();
  const completed_at = completed ? now : null;

  const { data, error: upsertError } = await supabase
    .from("course_content_progress")
    .upsert(
      {
        organization_id: caller.organization_id,
        course_id: id,
        user_id: caller.id,
        item_type,
        item_id,
        completed_at,
      },
      { onConflict: "user_id,course_id,item_type,item_id" }
    )
    .select("id, item_type, item_id, completed_at, updated_at")
    .single();

  if (upsertError || !data) {
    return NextResponse.json({ error: upsertError?.message || "Failed to update progress" }, { status: 400 });
  }

  return NextResponse.json({ ok: true, row: data }, { status: 200 });
}

