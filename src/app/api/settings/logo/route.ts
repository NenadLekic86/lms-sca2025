import { NextResponse } from 'next/server';
import { createAdminSupabaseClient, getServerUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB (matches your bucket limit)
const ALLOWED_MIME = new Set(['image/png', 'image/webp', 'image/svg+xml']);

function getExt(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'bin';
  }
}

export async function POST(request: Request) {
  // super_admin only
  const { user: caller, error } = await getServerUser();
  if (error || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (caller.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 });
  }

  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: `Invalid file type. Allowed: ${Array.from(ALLOWED_MIME).join(', ')}` },
      { status: 400 }
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File too large (max 2MB)' }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Versioned file name to avoid caching issues
  const ext = getExt(file.type);
  const ts = Date.now();
  const objectPath = `logos/app-logo-${ts}.${ext}`;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: uploadError } = await admin.storage
    .from('branding')
    .upload(objectPath, bytes, {
      contentType: file.type,
      upsert: true,
      cacheControl: '3600',
    });

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  const { data: publicUrlData } = admin.storage.from('branding').getPublicUrl(objectPath);
  const publicUrl = publicUrlData.publicUrl;

  // Update the single settings row
  const { data: current, error: currentError } = await admin
    .from('public_app_settings')
    .select('id')
    .single();

  if (currentError || !current?.id) {
    return NextResponse.json({ error: 'public_app_settings row not found' }, { status: 500 });
  }

  const { data: updated, error: updateError } = await admin
    .from('public_app_settings')
    .update({
      logo_url: publicUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', current.id)
    .select('id, logo_url')
    .single();

  if (updateError || !updated) {
    return NextResponse.json({ error: `Failed to update settings: ${updateError?.message}` }, { status: 500 });
  }

  // Best-effort audit log
  try {
    await admin.from('audit_logs').insert({
      actor_user_id: caller.id,
      actor_email: caller.email,
      actor_role: caller.role,
      action: 'upload_branding_logo',
      entity: 'storage.branding',
      entity_id: current.id,
      metadata: {
        bucket: 'branding',
        path: objectPath,
        logo_url: publicUrl,
        mime: file.type,
        size: file.size,
      },
    });
  } catch {
    // don't block success
  }

  return NextResponse.json(
    {
      message: 'Logo uploaded',
      logo_url: updated.logo_url,
      path: objectPath,
    },
    { status: 201 }
  );
}


