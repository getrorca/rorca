/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it, vi } from 'vitest';

const createClientMock = vi.fn(() => ({ mocked: true }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

describe('supabase client config', () => {
  it('creates a PKCE client with persisted browser session handling for OAuth redirects', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');

    await import('./supabase');

    expect(createClientMock).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key',
      {
        auth: {
          flowType: 'pkce',
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      },
    );
  });
});
