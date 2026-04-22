import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let missingConfigLogged = false;

function readEnvVar(name: 'SUPABASE_URL' | 'SUPABASE_ANON_KEY' | 'SUPABASE_SERVICE_ROLE_KEY'): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function warnMissingConfig(missingVars: string[]): void {
  if (missingConfigLogged) {
    return;
  }

  console.warn(
    `[supabase] Missing env vars: ${missingVars.join(', ')}. Backend will continue to boot; Supabase clients will fail only when first used.`
  );
  missingConfigLogged = true;
}

function getClientConfig(kind: 'anon' | 'admin'): { url: string; key: string } {
  const url = readEnvVar('SUPABASE_URL');
  const key = kind === 'admin'
    ? readEnvVar('SUPABASE_SERVICE_ROLE_KEY')
    : readEnvVar('SUPABASE_ANON_KEY');

  const missingVars = [
    !url ? 'SUPABASE_URL' : null,
    !key ? kind === 'admin' ? 'SUPABASE_SERVICE_ROLE_KEY' : 'SUPABASE_ANON_KEY' : null,
  ].filter((value): value is string => value !== null);

  if (missingVars.length > 0) {
    warnMissingConfig(missingVars);
    throw new Error(`Supabase ${kind} client is not configured. Missing: ${missingVars.join(', ')}`);
  }

  return { url, key };
}

function buildClient(kind: 'anon' | 'admin'): SupabaseClient {
  const { url, key } = getClientConfig(kind);

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

class LazyClient {
  private client: SupabaseClient | undefined;

  constructor(private readonly kind: 'anon' | 'admin') {}

  get(): SupabaseClient {
    if (!this.client) {
      this.client = buildClient(this.kind);
    }

    return this.client;
  }
}

const anonClient = new LazyClient('anon');
const adminClient = new LazyClient('admin');

export const supabaseAnon: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, property, receiver) {
    return Reflect.get(anonClient.get(), property, receiver);
  },
});

export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, property, receiver) {
    return Reflect.get(adminClient.get(), property, receiver);
  },
});

const missingAtImport = [
  !readEnvVar('SUPABASE_URL') ? 'SUPABASE_URL' : null,
  !readEnvVar('SUPABASE_ANON_KEY') ? 'SUPABASE_ANON_KEY' : null,
  !readEnvVar('SUPABASE_SERVICE_ROLE_KEY') ? 'SUPABASE_SERVICE_ROLE_KEY' : null,
].filter((value): value is string => value !== null);

if (missingAtImport.length > 0) {
  warnMissingConfig(missingAtImport);
}
