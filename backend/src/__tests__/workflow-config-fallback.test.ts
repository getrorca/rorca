/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * WR-017: Workflow config environment variable fallback tests.
 *
 * Verifies that users relying on .env configuration (RORCA_AGENT, RORCA_MODEL,
 * SPEC_PROVIDER) are not broken by the workflow_configs table.
 *
 * Key scenarios:
 *   (1) Default seed rows exist → env vars fill in NULL gaps (model)
 *       but DB-seeded runtime/provider take priority over env vars.
 *   (2) SPEC_PROVIDER env var fills provider when DB row has no explicit provider override.
 *   (3) With no env vars and default seed rows, hardcoded seed values are returned.
 */

// ── Mocks — must be declared before imports ──────────────────────────────────

/** In-memory store keyed by workflow_id — mirrors migration seed rows */
const workflowStore: Record<
  string,
  { workflow_id: string; runtime: string; provider: string; model: string | null }
> = {};

/** Seed the default rows exactly as migration 20260404000001 does */
function seedDefaults() {
  workflowStore['spec_generation'] = {
    workflow_id: 'spec_generation',
    runtime: 'native',
    provider: 'claude-cli',
    model: null,
  };
  workflowStore['pipeline_execution'] = {
    workflow_id: 'pipeline_execution',
    runtime: 'claude',
    provider: 'claude-cli',
    model: null,
  };
  workflowStore['memory_consolidation'] = {
    workflow_id: 'memory_consolidation',
    runtime: 'native',
    provider: 'claude-cli',
    model: null,
  };
}

const mockQueryOne = jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
  const id = params?.[0] as string | undefined;

  // SELECT from workflow_configs
  if (sql.includes('workflow_configs') && sql.includes('SELECT') && id) {
    return workflowStore[id] ?? undefined;
  }

  // SELECT from agent_config (Layer 2 fallback)
  if (sql.includes('agent_config')) {
    return undefined; // no agent_config rows in this test
  }

  return undefined;
});

jest.mock('../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

jest.mock('../routes/vault', () => ({
  getVaultKey: jest.fn().mockResolvedValue(null),
}));

jest.mock('../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { resolveWorkflowConfig } from '../lib/workflow-config-resolver';
import type { ResolvedWorkflowConfig } from '../lib/workflow-config-resolver';

// ── Env save / restore ───────────────────────────────────────────────────────

const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  // Re-seed the store to migration defaults before each test
  Object.keys(workflowStore).forEach((k) => delete workflowStore[k]);
  seedDefaults();
  // Clear env vars
  delete process.env.RORCA_AGENT;
  delete process.env.RORCA_MODEL;
  delete process.env.SPEC_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterAll(() => {
  process.env = originalEnv;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Workflow config env var fallback (WR-017)', () => {
  // ── Scenario 1: RORCA_AGENT + RORCA_MODEL with default seed rows ─────────

  describe('pipeline_execution — RORCA_AGENT and RORCA_MODEL env vars', () => {
    it('RORCA_AGENT env var overrides the default seed row runtime when DB row is absent', async () => {
      // Remove the seed row to simulate no explicit DB config
      delete workflowStore['pipeline_execution'];

      process.env.RORCA_AGENT = 'opencode';
      process.env.RORCA_MODEL = 'openai/gpt-4o';

      const result = await resolveWorkflowConfig('pipeline_execution');

      // Env vars should drive the values since no DB row exists
      expect(result.runtime).toBe('opencode');
      expect(result.model).toBe('openai/gpt-4o');
    });

    it('RORCA_MODEL fills in NULL model gap in default seed row', async () => {
      // Seed row has model=null → env var should fill the gap
      process.env.RORCA_MODEL = 'openai/gpt-4o';

      const result = await resolveWorkflowConfig('pipeline_execution');

      // runtime comes from DB seed ('claude'), model from env var
      expect(result.runtime).toBe('claude');
      expect(result.model).toBe('openai/gpt-4o');
      expect(result.provider).toBe('claude-cli');
    });

    it('DB seed runtime takes priority over RORCA_AGENT when seed row exists', async () => {
      // Seed row has runtime='claude' — DB Layer 1 has priority over env Layer 3
      process.env.RORCA_AGENT = 'opencode';

      const result = await resolveWorkflowConfig('pipeline_execution');

      // DB wins for runtime since it's non-null in the seed
      expect(result.runtime).toBe('claude');
    });

    it('both RORCA_AGENT and RORCA_MODEL apply when no DB row', async () => {
      delete workflowStore['pipeline_execution'];

      process.env.RORCA_AGENT = 'opencode';
      process.env.RORCA_MODEL = 'openai/gpt-4o';

      const result = await resolveWorkflowConfig('pipeline_execution');

      expect(result).toMatchObject({
        workflowId: 'pipeline_execution',
        runtime: 'opencode',
        model: 'openai/gpt-4o',
      });
    });
  });

  // ── Scenario 2: SPEC_PROVIDER with default seed rows ─────────────────────

  describe('spec_generation — SPEC_PROVIDER env var', () => {
    it('SPEC_PROVIDER env var overrides provider when DB row is absent', async () => {
      delete workflowStore['spec_generation'];

      process.env.SPEC_PROVIDER = 'openrouter';

      const result = await resolveWorkflowConfig('spec_generation');

      expect(result.provider).toBe('openrouter');
      // Runtime falls to hardcoded default since no DB row
      expect(result.runtime).toBe('native');
    });

    it('DB seed provider takes priority over SPEC_PROVIDER when seed row exists', async () => {
      // Seed row has provider='claude-cli'
      process.env.SPEC_PROVIDER = 'openrouter';

      const result = await resolveWorkflowConfig('spec_generation');

      // DB wins for provider
      expect(result.provider).toBe('claude-cli');
      expect(result.runtime).toBe('native');
    });

    it('SPEC_PROVIDER=anthropic sets provider when no DB row', async () => {
      delete workflowStore['spec_generation'];

      process.env.SPEC_PROVIDER = 'anthropic';

      const result = await resolveWorkflowConfig('spec_generation');

      expect(result.provider).toBe('anthropic');
    });

    it('SPEC_PROVIDER=claude maps to claude-cli when no DB row', async () => {
      delete workflowStore['spec_generation'];

      process.env.SPEC_PROVIDER = 'claude';

      const result = await resolveWorkflowConfig('spec_generation');

      expect(result.provider).toBe('claude-cli');
    });
  });

  // ── Scenario 3: No env vars, default seed rows → hardcoded defaults ──────

  describe('no env vars — default seed rows return expected values', () => {
    it('spec_generation returns runtime=native with default seed', async () => {
      const result = await resolveWorkflowConfig('spec_generation');

      expect(result).toEqual<ResolvedWorkflowConfig>({
        workflowId: 'spec_generation',
        runtime: 'native',
        provider: 'claude-cli',
        model: null,
        apiKey: null,
        baseUrl: null,
      });
    });

    it('pipeline_execution returns runtime=claude with default seed', async () => {
      const result = await resolveWorkflowConfig('pipeline_execution');

      expect(result).toEqual<ResolvedWorkflowConfig>({
        workflowId: 'pipeline_execution',
        runtime: 'claude',
        provider: 'claude-cli',
        model: null,
        apiKey: null,
        baseUrl: null,
      });
    });

    it('memory_consolidation returns runtime=native with default seed', async () => {
      const result = await resolveWorkflowConfig('memory_consolidation');

      expect(result).toEqual<ResolvedWorkflowConfig>({
        workflowId: 'memory_consolidation',
        runtime: 'native',
        provider: 'claude-cli',
        model: null,
        apiKey: null,
        baseUrl: null,
      });
    });
  });

  // ── Combined env var scenarios ─────────────────────────────────────────────

  describe('combined env var scenarios', () => {
    it('all env vars apply when workflow_configs table is missing', async () => {
      // Simulate table not existing — queryOne throws
      mockQueryOne.mockRejectedValue(new Error('relation "workflow_configs" does not exist'));

      process.env.RORCA_AGENT = 'opencode';
      process.env.RORCA_MODEL = 'openai/gpt-4o';
      process.env.SPEC_PROVIDER = 'openrouter';

      const result = await resolveWorkflowConfig('pipeline_execution');

      expect(result.runtime).toBe('opencode');
      expect(result.model).toBe('openai/gpt-4o');
      expect(result.provider).toBe('openrouter');
    });

    it('RORCA_AGENT=codex resolves to codex runtime when no DB row', async () => {
      delete workflowStore['pipeline_execution'];

      process.env.RORCA_AGENT = 'codex';

      const result = await resolveWorkflowConfig('pipeline_execution');

      expect(result.runtime).toBe('codex');
    });

    it('env vars are case-insensitive and trimmed', async () => {
      delete workflowStore['pipeline_execution'];

      process.env.RORCA_AGENT = '  OpenCode  ';
      process.env.RORCA_MODEL = '  openai/gpt-4o  ';

      const result = await resolveWorkflowConfig('pipeline_execution');

      expect(result.runtime).toBe('opencode');
      expect(result.model).toBe('openai/gpt-4o');
    });

    it('unknown RORCA_AGENT value falls through to hardcoded default', async () => {
      delete workflowStore['pipeline_execution'];

      process.env.RORCA_AGENT = 'unknown_agent';

      const result = await resolveWorkflowConfig('pipeline_execution');

      // Unknown agent not in AGENT_TO_RUNTIME map — falls to hardcoded default
      expect(result.runtime).toBe('claude');
    });
  });
});
