import express from 'express';
import request from 'supertest';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      insert: jest.fn().mockResolvedValue({ error: null }),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [], error: null }),
      delete: jest.fn().mockReturnThis(),
    })),
  })),
}));

jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  execute: jest.fn(),
}));

jest.mock('../../lib/llm-client', () => ({ chatComplete: jest.fn() }));
jest.mock('../../lib/embedding-pipeline', () => ({ invalidateProviderCache: jest.fn() }));

const { query, queryOne, execute } = require('../../db/index');
const vaultRouter = require('../vault').default;

describe('vault route auth regression', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'test-secret',
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_ANON_KEY: 'anon-key',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function makeApp(workspaceRole: 'member' | 'admin' | 'owner') {
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT role FROM workspace_members')) {
        return { role: workspaceRole };
      }
      if (sql.includes('SELECT id FROM openrouter_provider_prefs')) {
        return null;
      }
      return null;
    });

    query.mockResolvedValue([
      {
        id: 'global-pref',
        workspace_id: null,
        model_id: 'anthropic/claude-sonnet-4-5',
        pref_order: ['DeepInfra'],
        ignore_list: ['Ambient'],
        allow_fallbacks: true,
      },
      {
        id: 'workspace-pref',
        workspace_id: 'ws-1',
        model_id: 'anthropic/claude-sonnet-4-5',
        pref_order: ['SiliconFlow'],
        ignore_list: [],
        allow_fallbacks: false,
      },
    ]);
    execute.mockResolvedValue(undefined);

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = {
        id: 'app-user-1',
        email: 'member@example.com',
        supabaseId: 'auth-user-1',
        role: 'user',
      };
      next();
    });
    app.use('/api/vault/keys', vaultRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message || 'error' });
    });
    return app;
  }

  test('workspace member can read workspace-scoped OpenRouter prefs', async () => {
    const app = makeApp('member');
    const response = await request(app).get('/api/vault/keys/openrouter-provider-prefs?workspaceId=ws-1');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body[0]).toMatchObject({ workspaceId: null, modelId: 'anthropic/claude-sonnet-4-5' });
    expect(response.body[1]).toMatchObject({ workspaceId: 'ws-1', modelId: 'anthropic/claude-sonnet-4-5' });
  });

  test('workspace member cannot mutate workspace default provider', async () => {
    const app = makeApp('member');
    const response = await request(app)
      .put('/api/vault/keys/default-provider')
      .send({ workspaceId: 'ws-1', provider: 'openrouter' });

    expect(response.status).toBe(403);
  });

  test('workspace member cannot mutate workspace-scoped OpenRouter prefs', async () => {
    const app = makeApp('member');
    const response = await request(app)
      .put('/api/vault/keys/openrouter-provider-prefs')
      .send({ workspaceId: 'ws-1', modelId: 'anthropic/claude-sonnet-4-5', order: ['SiliconFlow'] });

    expect(response.status).toBe(403);
  });
});
