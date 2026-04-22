import type { Request } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AuthError } from './errors';

function requireEnv(name: 'SUPABASE_URL' | 'SUPABASE_ANON_KEY'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required Supabase env var: ${name}`);
  }
  return value;
}

export function withUserClient(req: Request): SupabaseClient {
  const authHeader = req.header('authorization') ?? req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    throw new AuthError('Missing bearer token');
  }

  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}
