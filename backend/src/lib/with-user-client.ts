import type { Request } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AuthError } from './errors';

function getBearerToken(req: Request): string | null {
  const header = req.header('authorization') || req.header('Authorization');
  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function withUserClient(req: Request): SupabaseClient {
  const accessToken = getBearerToken(req);
  if (!accessToken) {
    throw new AuthError('Authorization bearer token is required for RLS-enforced routes');
  }

  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    throw new AuthError('Supabase anon client is not configured for RLS-enforced routes');
  }

  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}
