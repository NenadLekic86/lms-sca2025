import { supabase } from '@/lib/supabase/client';

export async function loadBranding() {
  const { data, error } = await supabase
    .from('public_app_settings')
    .select('app_name, logo_url, updated_at')
    .single();

  if (error || !data) {
    console.warn('Using default branding');
    return { app_name: 'ISO LMS', logo_url: null as string | null, updated_at: null as string | null };
  }
  
  return data;
}
