import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabaseClient, getServerUser } from '@/lib/supabase/server';
import { revalidateTag } from "next/cache";
import { PUBLIC_APP_SETTINGS_THEME_TAG } from "@/lib/theme/themeConstants";
import { updateSettingsSchema, validateSchema } from '@/lib/validations/schemas';

type PublicAppSettings = {
  id: string;
  app_name: string | null;
  logo_url: string | null;
  theme: Record<string, string> | string | null;
  default_language: string | null;
  timezone: string | null;
  updated_at?: string | null;
};

function parseTheme(theme: unknown): Record<string, string> | null {
  if (!theme) return null;
  if (typeof theme === 'object') return theme as Record<string, string>;
  if (typeof theme === 'string') {
    try {
      const parsed = JSON.parse(theme);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function GET() {
  // super_admin only
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (caller.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const admin = createAdminSupabaseClient();
  const { data, error: settingsError } = await admin
    .from('public_app_settings')
    .select('id, app_name, logo_url, theme, default_language, timezone, updated_at')
    .single();

  if (settingsError) {
    return NextResponse.json({ error: settingsError.message }, { status: 500 });
  }

  const settings = data as PublicAppSettings;
  return NextResponse.json({
    settings: {
      ...settings,
      theme: parseTheme(settings.theme) ?? {},
    },
  });
}

export async function PATCH(request: NextRequest) {
  // super_admin only
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (caller.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Parse body
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate with zod (partial validation - settings can update any subset of fields)
  const validation = validateSchema(updateSettingsSchema, body);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const validatedData = validation.data;

  const admin = createAdminSupabaseClient();

  // Load current row (single row) to do a safe update and for audit metadata
  const { data: current, error: currentError } = await admin
    .from('public_app_settings')
    .select('id, app_name, logo_url, theme, default_language, timezone')
    .single();

  if (currentError || !current) {
    return NextResponse.json({ error: currentError?.message || 'Settings row not found' }, { status: 500 });
  }

  const currentSettings = current as PublicAppSettings;
  const settingsId = currentSettings.id;

  // Build the update payload
  const updatePayload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  // Handle app_name
  if ('app_name' in validatedData) {
    const trimmed = validatedData.app_name?.trim() || '';
    updatePayload.app_name = trimmed.length > 0 ? trimmed : null;
  }

  // Handle logo_url
  if ('logo_url' in validatedData) {
    const trimmed = validatedData.logo_url?.trim() || '';
    updatePayload.logo_url = trimmed.length > 0 ? trimmed : null;
  }

  // Handle default_language
  if ('default_language' in validatedData) {
    updatePayload.default_language = validatedData.default_language;
  }

  // Handle timezone
  if ('timezone' in validatedData) {
    updatePayload.timezone = validatedData.timezone;
  }

  // Handle theme
  if ('theme' in validatedData) {
    updatePayload.theme = validatedData.theme;
  }

  // Check that at least one branding field will be present after update
  const nextAppName = 'app_name' in updatePayload 
    ? updatePayload.app_name 
    : currentSettings.app_name;
  const nextLogoUrl = 'logo_url' in updatePayload 
    ? updatePayload.logo_url 
    : currentSettings.logo_url;

  if (!nextAppName && !nextLogoUrl) {
    return NextResponse.json(
      { error: 'Branding invalid: you must provide at least app_name or logo_url' },
      { status: 400 }
    );
  }

  const { data: updated, error: updateError } = await admin
    .from('public_app_settings')
    .update(updatePayload)
    .eq('id', settingsId)
    .select('id, app_name, logo_url, theme, default_language, timezone, updated_at')
    .single();

  if (updateError || !updated) {
    return NextResponse.json({ error: updateError?.message || 'Failed to update settings' }, { status: 500 });
  }

  // Best-effort audit log
  try {
    await admin.from('audit_logs').insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: 'update_public_app_settings',
      entity: 'public_app_settings',
      entity_id: settingsId,
      metadata: {
        patch_keys: Object.keys(body as Record<string, unknown>),
      },
    });
  } catch {
    // do not block success
  }

  const updatedSettings = updated as PublicAppSettings;

  // Invalidate the server-rendered theme cache so first paint uses the latest theme immediately.
  try {
    // Next.js 16 requires a second argument for tag revalidation
    revalidateTag(PUBLIC_APP_SETTINGS_THEME_TAG, { expire: 0 });
  } catch {
    // Best-effort; do not block success.
  }

  return NextResponse.json({
    message: 'Settings updated',
    settings: {
      ...updatedSettings,
      theme: parseTheme(updatedSettings.theme) ?? {},
    },
  });
}
