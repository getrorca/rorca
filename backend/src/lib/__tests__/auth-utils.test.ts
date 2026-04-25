jest.mock('../supabase', () => ({
  supabaseAdmin: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(),
  execute: jest.fn(),
}));

describe('resolveAuthUserFromToken', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, SUPABASE_URL: 'http://127.0.0.1:54321' };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  test('returns DB-backed app role instead of blindly elevating token user', async () => {
    const { supabaseAdmin } = require('../supabase');
    const db = require('../../db/index');

    supabaseAdmin.auth.getUser.mockResolvedValue({
      data: {
        user: {
          id: 'auth-user-1',
          email: 'member@example.com',
          email_confirmed_at: null,
        },
      },
      error: null,
    });

    db.queryOne
      .mockResolvedValueOnce({ id: 'app-user-1', email: 'member@example.com', role: 'user', plan: 'free' })
      .mockResolvedValueOnce({ id: 'existing-admin' });

    const { resolveAuthUserFromToken } = require('../auth-utils');
    const user = await resolveAuthUserFromToken('token-123');

    expect(user).toEqual({
      id: 'app-user-1',
      email: 'member@example.com',
      supabaseId: 'auth-user-1',
      role: 'user',
      plan: 'free',
    });
  });

  test('returns null when token is invalid', async () => {
    const { supabaseAdmin } = require('../supabase');
    supabaseAdmin.auth.getUser.mockResolvedValue({ data: { user: null }, error: new Error('bad token') });

    const { resolveAuthUserFromToken } = require('../auth-utils');
    await expect(resolveAuthUserFromToken('bad-token')).resolves.toBeNull();
  });
});
