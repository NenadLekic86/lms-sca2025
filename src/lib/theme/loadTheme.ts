import { supabase } from '@/lib/supabase/client';

export async function loadAppTheme() {
  const { data, error } = await supabase
    .from('public_app_settings')
    .select('theme')
    .single();

  if (error || !data?.theme) {
    console.warn('Using default theme');
    return null;
  }

  return data.theme as Record<string, string>;
}
