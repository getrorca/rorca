import { createClient } from '@supabase/supabase-js';

/*
 * Security model: Supabase OAuth uses PKCE. The PKCE code verifier MUST be persisted
 * across the OAuth redirect (the full-page redirect to GitHub and back destroys
 * in-memory state), so we let the SDK use its default localStorage. Session tokens
 * are stored there as well; `detectSessionInUrl` is enabled for the callback page
 * to complete the exchange.
 */

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(
  supabaseUrl || 'http://localhost:54321',
  supabaseAnonKey || 'placeholder-anon-key',
  {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);

export { createClient };
export type * from '@supabase/supabase-js';
