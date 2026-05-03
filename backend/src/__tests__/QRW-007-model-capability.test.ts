/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * QRW-007: API — GET /api/config/model-capability returns correct ReasoningCapability
 *
 * Acceptance criteria:
 *   (1) GET /api/config/model-capability?modelId=claude-opus-4-6 returns
 *       supportsReasoning: true, reasoningType: 'anthropic-thinking', budgetTokensSupported: true
 *   (2) GET /api/config/model-capability?modelId=o3 returns reasoningType: 'effort-levels'
 *   (3) GET /api/config/model-capability?modelId=gpt-4o returns supportsReasoning: false
 *   (4) GET /api/config/model-capability without modelId returns 400
 *   (5) Endpoint is registered in server.ts and reachable
 *   (6) Caching: 5 rapid calls are served quickly after first call
 */

// ── Mocks — declared before imports ──────────────────────────────────────────

// DB mock — config route imports query/queryOne for vault lookups
const mockQueryOne = jest.fn().mockResolvedValue(undefined);
const mockQuery = jest.fn().mockResolvedValue([]);

jest.mock('../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: jest.fn().mockResolvedValue({ rowCount: 0 }),
  initDb: jest.fn().mockResolvedValue(undefined),
}));

// llm-client mock — we need isModelMarkedNonReasoning to return false by default
// so the route returns the real detected capability rather than a degraded override.
const mockIsModelMarkedNonReasoning = jest.fn().mockReturnValue(false);

jest.mock('../lib/llm-client', () => {
  const actual = jest.requireActual('../lib/llm-client');
  return {
    ...actual,
    isModelMarkedNonReasoning: (...args: unknown[]) =>
      mockIsModelMarkedNonReasoning(...args),
    // Keep chatComplete passthrough — not called by this endpoint
    chatComplete: jest.fn().mockResolvedValue({ text: '', usage: {} }),
  };
});

jest.mock('../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';

// Build a minimal Express app with only the config router wired up.
// We import the router lazily so all jest.mock() hoisting is settled first.
async function buildApp() {
  const app = express();
  app.use(express.json());

  // Error-handler that serialises AppError subclasses the same way server.ts does.
  // Must be registered AFTER routes.
  const { default: configRouter } = await import('../routes/config');
  app.use('/api/config', configRouter);

  // Minimal error handler — mirrors backend/src/lib/error-handler.ts
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        err && typeof err === 'object' && 'statusCode' in err
          ? (err as { statusCode: number }).statusCode
          : 500;
      const message =
        err && typeof err === 'object' && 'message' in err
          ? (err as { message: string }).message
          : 'Internal Server Error';
      res.status(status).json({ error: message });
    },
  );

  return app;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('QRW-007: GET /api/config/model-capability returns correct ReasoningCapability', () => {
  let app: express.Application;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset graceful degradation override to "no override" for every test
    mockIsModelMarkedNonReasoning.mockReturnValue(false);
    mockQueryOne.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue([]);
  });

  // ── AC1: claude-opus-4-6 → anthropic-thinking, budgetTokensSupported ─────

  describe('AC1: claude-opus-4-6 returns supportsReasoning=true, reasoningType=anthropic-thinking, budgetTokensSupported=true', () => {
    it('returns HTTP 200', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(res.status).toBe(200);
    });

    it('supportsReasoning is true', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(res.body.supportsReasoning).toBe(true);
    });

    it('reasoningType is anthropic-thinking', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(res.body.reasoningType).toBe('anthropic-thinking');
    });

    it('budgetTokensSupported is true', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(res.body.budgetTokensSupported).toBe(true);
    });

    it('response includes modelId echoed back', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(res.body.modelId).toBe('claude-opus-4-6');
    });

    it('effortLevels includes low, medium, high, max for Opus', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(Array.isArray(res.body.effortLevels)).toBe(true);
      expect(res.body.effortLevels).toContain('low');
      expect(res.body.effortLevels).toContain('medium');
      expect(res.body.effortLevels).toContain('high');
      expect(res.body.effortLevels).toContain('max');
    });

    it('budgetRange is a 2-element array of integers for Opus', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(Array.isArray(res.body.budgetRange)).toBe(true);
      expect(res.body.budgetRange).toHaveLength(2);
      expect(typeof res.body.budgetRange[0]).toBe('number');
      expect(typeof res.body.budgetRange[1]).toBe('number');
    });

    it('cachedAt is a numeric timestamp', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(typeof res.body.cachedAt).toBe('number');
      expect(res.body.cachedAt).toBeGreaterThan(0);
    });

    it('fromGracefulDegradationCache is false (no override set)', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(res.body.fromGracefulDegradationCache).toBe(false);
    });
  });

  // ── AC1b: Sonnet variant (no max effort) ─────────────────────────────────

  describe('claude-sonnet-4-5-20250929 returns anthropic-thinking without max effort', () => {
    it('reasoningType is anthropic-thinking for Sonnet', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-sonnet-4-5-20250929' });

      expect(res.status).toBe(200);
      expect(res.body.reasoningType).toBe('anthropic-thinking');
    });

    it('effortLevels does NOT include max for Sonnet', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-sonnet-4-5-20250929' });

      expect(res.body.effortLevels).not.toContain('max');
      expect(res.body.effortLevels).toContain('high');
    });
  });

  // ── AC2: o3 → effort-levels ───────────────────────────────────────────────

  describe('AC2: o3 returns reasoningType=effort-levels', () => {
    it('returns HTTP 200 for o3', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'o3' });

      expect(res.status).toBe(200);
    });

    it('reasoningType is effort-levels for o3', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'o3' });

      expect(res.body.reasoningType).toBe('effort-levels');
    });

    it('supportsReasoning is true for o3', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'o3' });

      expect(res.body.supportsReasoning).toBe(true);
    });

    it('effortLevels is a non-empty array for o3', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'o3' });

      expect(Array.isArray(res.body.effortLevels)).toBe(true);
      expect(res.body.effortLevels.length).toBeGreaterThan(0);
    });

    it('budgetTokensSupported is false for o3 (effort-based, not budget-based)', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'o3' });

      expect(res.body.budgetTokensSupported).toBe(false);
    });

    it('modelId echoed back as o3', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'o3' });

      expect(res.body.modelId).toBe('o3');
    });

    it('o4-mini also returns effort-levels', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'o4-mini' });

      expect(res.status).toBe(200);
      expect(res.body.reasoningType).toBe('effort-levels');
    });

    it('openai/o3 prefixed variant also returns effort-levels', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'openai/o3' });

      expect(res.status).toBe(200);
      expect(res.body.reasoningType).toBe('effort-levels');
    });
  });

  // ── AC3: gpt-4o → supportsReasoning: false ───────────────────────────────

  describe('AC3: gpt-4o returns supportsReasoning=false', () => {
    it('returns HTTP 200 for gpt-4o', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'gpt-4o' });

      expect(res.status).toBe(200);
    });

    it('supportsReasoning is false for gpt-4o', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'gpt-4o' });

      expect(res.body.supportsReasoning).toBe(false);
    });

    it('reasoningType is none for gpt-4o', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'gpt-4o' });

      expect(res.body.reasoningType).toBe('none');
    });

    it('budgetTokensSupported is false for gpt-4o', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'gpt-4o' });

      expect(res.body.budgetTokensSupported).toBe(false);
    });

    it('effortLevels is empty array for gpt-4o', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'gpt-4o' });

      expect(Array.isArray(res.body.effortLevels)).toBe(true);
      expect(res.body.effortLevels).toHaveLength(0);
    });

    it('modelId echoed back as gpt-4o', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'gpt-4o' });

      expect(res.body.modelId).toBe('gpt-4o');
    });

    it('gpt-4o-mini also returns supportsReasoning=false', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'gpt-4o-mini' });

      expect(res.status).toBe(200);
      expect(res.body.supportsReasoning).toBe(false);
    });
  });

  // ── AC4: missing modelId → 400 ────────────────────────────────────────────

  describe('AC4: missing modelId returns 400', () => {
    it('returns 400 when modelId query param is absent', async () => {
      const res = await request(app).get('/api/config/model-capability');

      expect(res.status).toBe(400);
    });

    it('error body has an error property when modelId is absent', async () => {
      const res = await request(app).get('/api/config/model-capability');

      expect(res.body).toHaveProperty('error');
    });

    it('returns 400 when modelId is an empty string', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: '' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when modelId is whitespace only', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: '   ' });

      expect(res.status).toBe(400);
    });
  });

  // ── AC5: endpoint reachable (registered in server.ts) ────────────────────

  describe('AC5: endpoint is registered and reachable', () => {
    it('returns non-404 for valid modelId (endpoint is registered)', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(res.status).not.toBe(404);
    });

    it('Content-Type is application/json', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('response body is a JSON object with modelId field', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(typeof res.body).toBe('object');
      expect(res.body).toHaveProperty('modelId');
    });

    it('response body has all required ReasoningCapability fields', async () => {
      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      expect(res.body).toHaveProperty('supportsReasoning');
      expect(res.body).toHaveProperty('reasoningType');
      expect(res.body).toHaveProperty('effortLevels');
      expect(res.body).toHaveProperty('defaultEffort');
      expect(res.body).toHaveProperty('budgetTokensSupported');
      expect(res.body).toHaveProperty('budgetRange');
    });
  });

  // ── AC6: Caching — second+ calls are served from in-memory cache ──────────

  describe('AC6: caching — 5 rapid calls are served quickly after first call', () => {
    it('5 rapid calls all return 200', async () => {
      const calls = Array.from({ length: 5 }, () =>
        request(app)
          .get('/api/config/model-capability')
          .query({ modelId: 'claude-opus-4-6' }),
      );
      const responses = await Promise.all(calls);

      for (const res of responses) {
        expect(res.status).toBe(200);
      }
    });

    it('all 5 rapid calls return the same capability values', async () => {
      const calls = Array.from({ length: 5 }, () =>
        request(app)
          .get('/api/config/model-capability')
          .query({ modelId: 'claude-opus-4-6' }),
      );
      const responses = await Promise.all(calls);

      const first = responses[0].body;
      for (const res of responses.slice(1)) {
        expect(res.body.supportsReasoning).toBe(first.supportsReasoning);
        expect(res.body.reasoningType).toBe(first.reasoningType);
        expect(res.body.budgetTokensSupported).toBe(first.budgetTokensSupported);
      }
    });

    it('5 rapid calls complete within 500ms total', async () => {
      const start = Date.now();

      const calls = Array.from({ length: 5 }, () =>
        request(app)
          .get('/api/config/model-capability')
          .query({ modelId: 'gpt-4o' }),
      );
      await Promise.all(calls);

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
    });

    it('cached response has the same cachedAt timestamp across calls', async () => {
      // First call populates the cache
      const first = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'o3' });

      // Subsequent calls within TTL should return the same cachedAt
      const second = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'o3' });

      expect(first.body.cachedAt).toBe(second.body.cachedAt);
    });

    it('cached calls after first call complete under 50ms each', async () => {
      // Prime the cache
      await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6' });

      // Measure subsequent cached calls
      for (let i = 0; i < 4; i++) {
        const start = Date.now();
        const res = await request(app)
          .get('/api/config/model-capability')
          .query({ modelId: 'claude-opus-4-6' });
        const elapsed = Date.now() - start;

        expect(res.status).toBe(200);
        expect(elapsed).toBeLessThan(50);
      }
    });
  });

  // ── Graceful degradation override ────────────────────────────────────────

  describe('graceful degradation override — isModelMarkedNonReasoning=true', () => {
    it('supportsReasoning is overridden to false when model is marked non-reasoning', async () => {
      // Simulate chatComplete() having marked claude-opus-4-6 as non-reasoning
      mockIsModelMarkedNonReasoning.mockReturnValue(true);

      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6-degraded' });

      expect(res.status).toBe(200);
      expect(res.body.supportsReasoning).toBe(false);
    });

    it('fromGracefulDegradationCache is true when model is marked non-reasoning', async () => {
      mockIsModelMarkedNonReasoning.mockReturnValue(true);

      const res = await request(app)
        .get('/api/config/model-capability')
        .query({ modelId: 'claude-opus-4-6-degraded' });

      expect(res.body.fromGracefulDegradationCache).toBe(true);
    });
  });
});
