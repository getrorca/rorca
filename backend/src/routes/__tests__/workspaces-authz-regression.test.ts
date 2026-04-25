import express from 'express';
import request from 'supertest';

jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  execute: jest.fn(),
}));

jest.mock('../../db/user-client', () => ({
  withUserClient: jest.fn(),
}));

jest.mock('../../lib/validate', () => ({
  validateBody: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../lib/schema-hydrator', () => ({ hydrateSchema: jest.fn() }));
jest.mock('../../lib/git-hydrator', () => ({ gitMapStep: jest.fn(), gitReduceStep: jest.fn(), getLatestHash: jest.fn() }));
jest.mock('../../lib/llm-client', () => ({ chatComplete: jest.fn() }));
jest.mock('../../lib/direction-validator', () => ({ validateDirectionYaml: jest.fn() }));
jest.mock('../../lib/paginate', () => ({ parsePaginationParams: jest.fn(), paginateArray: jest.fn() }));
jest.mock('../../lib/workspace-echolocation', () => ({
  echolocate: jest.fn(),
  computeHealthReport: jest.fn(),
  discoverMonorepo: jest.fn(),
  generateMonorepoCLAUDESection: jest.fn(),
  inferSkillsFromStack: jest.fn(),
}));
jest.mock('../../lib/knowledge-graph', () => ({ graphStats: jest.fn() }));
jest.mock('../../lib/embedding-pipeline', () => ({ getEmbeddingCounts: jest.fn() }));
jest.mock('../../lib/rorca-config', () => ({
  loadRorcaConfig: jest.fn(),
  writeRorcaConfig: jest.fn(),
  hasRorcaDir: jest.fn(),
  ensureRorcaDirStructure: jest.fn(),
  defaultRorcaConfig: jest.fn(),
}));
jest.mock('../../lib/workspace-scaffold', () => ({ generateScaffoldPreview: jest.fn(), writeScaffoldFiles: jest.fn() }));
jest.mock('../../lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../lib/require-plan', () => ({ requirePlan: () => (_req: any, _res: any, next: any) => next() }));
jest.mock('../../lib/domain-inference', () => ({ inferDomain: jest.fn() }));
jest.mock('../../lib/pty-manager', () => ({ killSessionsForWorkspace: jest.fn() }));

const { queryOne } = require('../../db/index');
const workspacesRouter = require('../workspaces').default;

describe('workspaces route auth regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeApp(role: 'member' | 'admin' | 'owner' = 'member') {
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT role FROM workspace_members')) {
        return { role };
      }
      return null;
    });

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
    app.use('/api/workspaces', workspacesRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message || 'error' });
    });
    return app;
  }

  test('member cannot patch workspace settings', async () => {
    const app = makeApp('member');
    const response = await request(app)
      .patch('/api/workspaces/ws-1')
      .send({ label: 'New name' });

    expect(response.status).toBe(403);
  });

  test('member cannot delete workspace', async () => {
    const app = makeApp('member');
    const response = await request(app).delete('/api/workspaces/ws-1');

    expect(response.status).toBe(403);
  });
});
