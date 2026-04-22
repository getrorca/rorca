import { createClient } from '@supabase/supabase-js';

/*
 * Security model: Supabase OAuth uses PKCE and keeps session tokens in JS memory only.
 * Tokens are not persisted to localStorage, sessionStorage, or cookies by this client.
 * PKCE mitigates auth code interception during the OAuth redirect exchange.
 * In-session token refresh is handled automatically by the Supabase SDK.
 * Full page reloads clear the session and require re-authentication by design.
 */

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    flowType: 'pkce',
    storage: undefined,
    persistSession: false,
  },
});

export { createClient };
export type * from '@supabase/supabase-js';
