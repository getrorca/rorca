import { describe, expect, it, vi } from 'vitest';

const createClientMock = vi.fn(() => ({ mocked: true }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

describe('supabase client config', () => {
  it('creates a PKCE client with in-memory-only sessions', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');

    await import('./supabase');

    expect(createClientMock).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key',
      {
        auth: {
          flowType: 'pkce',
          storage: undefined,
          persistSession: false,
        },
      },
    );
  });
});
