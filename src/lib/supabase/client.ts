import { createBrowserClient } from '@supabase/ssr';
import { env } from '@/env.mjs';

// Browser client with cookie-based session
export const supabase = createBrowserClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  {
    auth: {
      flowType: 'implicit',
    },
  }
);

