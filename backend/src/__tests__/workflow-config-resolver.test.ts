/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Tests for workflow-config-resolver (WR-002).
 * Covers the full resolution chain: DB → agent_config → env vars → defaults.
 */

// ── Mocks — must be declared before imports ──────────────────────────────────

jest.mock('../db/index', () => ({
  queryOne: jest.fn(),
}));

jest.mock('../routes/vault', () => ({
  getVaultKey: jest.fn(),
}));

jest.mock('../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { resolveWorkflowConfig } from '../lib/workflow-config-resolver';
import type { ResolvedWorkflowConfig } from '../lib/workflow-config-resolver';
import { queryOne } from '../db/index';
import { getVaultKey } from '../routes/vault';

const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
const mockGetVaultKey = getVaultKey as jest.MockedFunction<typeof getVaultKey>;

// Save and restore env vars
const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  // Clear relevant env vars
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

describe('resolveWorkflowConfig', () => {
  // ── Layer 1: DB workflow_configs row found ──────────────────────────────

  describe('DB row found', () => {
    it('returns DB values for spec_generation', async () => {
      mockQueryOne.mockResolvedValueOnce({
        workflow_id: 'spec_generation',
        runtime: 'opencode',
        provider: 'openrouter',
        model: 'openrouter/auto',
      });

      const result = await resolveWorkflowConfig('spec_generation');

      expect(result).toEqual<ResolvedWorkflowConfig>({
        workflowId: 'spec_generation',
        runtime: 'opencode',
        provider: 'openrouter',
        model: 'openrouter/auto',
        apiKey: null,
        baseUrl: null,
      });
      expect(mockQueryOne).toHaveBeenCalledWith(
        expect.stringContaining('workflow_configs'),
        ['spec_generation'],
      );
    });

    it('returns DB values for pipeline_execution without hitting agent_config', async () => {
      mockQueryOne.mockResolvedValueOnce({
        workflow_id: 'pipeline_execution',
        runtime: 'codex',
        provider: 'claude-cli',
        model: null,
      });

      const result = await resolveWorkflowConfig('pipeline_execution');

      expect(result.runtime).toBe('codex');
      expect(result.provider).toBe('claude-cli');
      // Should only query workflow_configs, not agent_config
      expect(mockQueryOne).toHaveBeenCalledTimes(1);
    });
  });

  // ── Layer 2: agent_config fallback (pipeline_execution only) ───────────

  describe('agent_config fallback', () => {
    it('falls back to agent_config for pipeline_execution when DB row missing', async () => {
      // workflow_configs returns nothing
      mockQueryOne.mockResolvedValueOnce(undefined);
      // agent_config returns persisted values
      mockQueryOne.mockResolvedValueOnce({
        agent_type: 'opencode',
        agent_model: 'openai/gpt-4o',
      });

      const result = await resolveWorkflowConfig('pipeline_execution');

      expect(result.runtime).toBe('opencode');
      expect(result.model).toBe('openai/gpt-4o');
      expect(mockQueryOne).toHaveBeenCalledTimes(2);
      expect(mockQueryOne).toHaveBeenNthCalledWith(2,
        expect.stringContaining('agent_config'),
        ['default'],
      );
    });

    it('does NOT fall back to agent_config for spec_generation', async () => {
      mockQueryOne.mockResolvedValueOnce(undefined);

      const result = await resolveWorkflowConfig('spec_generation');

      // Only 1 query (workflow_configs), no agent_config query
      expect(mockQueryOne).toHaveBeenCalledTimes(1);
      // Should get hardcoded defaults
      expect(result.runtime).toBe('native');
    });

    it('does NOT fall back to agent_config for memory_consolidation', async () => {
      mockQueryOne.mockResolvedValueOnce(undefined);

      const result = await resolveWorkflowConfig('memory_consolidation');

      expect(mockQueryOne).toHaveBeenCalledTimes(1);
      expect(result.runtime).toBe('native');
    });
  });

  // ── Layer 3: env var fallback ─────────────────────────────────────────

  describe('env var fallback', () => {
    it('reads RORCA_AGENT and RORCA_MODEL when DB is empty', async () => {
      mockQueryOne.mockResolvedValue(undefined);
      process.env.RORCA_AGENT = 'opencode';
      process.env.RORCA_MODEL = 'google/gemini-2.5-pro';

      const result = await resolveWorkflowConfig('pipeline_execution');

      expect(result.runtime).toBe('opencode');
      expect(result.model).toBe('google/gemini-2.5-pro');
    });

    it('reads SPEC_PROVIDER for provider when DB is empty', async () => {
      mockQueryOne.mockResolvedValue(undefined);
      process.env.SPEC_PROVIDER = 'anthropic';

      const result = await resolveWorkflowConfig('spec_generation');

      expect(result.provider).toBe('anthropic');
    });

    it('maps SPEC_PROVIDER=claude to claude-cli', async () => {
      mockQueryOne.mockResolvedValue(undefined);
      process.env.SPEC_PROVIDER = 'claude';

      const result = await resolveWorkflowConfig('spec_generation');

      expect(result.provider).toBe('claude-cli');
    });
  });

  // ── Layer 4: hardcoded defaults ──────────────────────────────────────

  describe('hardcoded defaults', () => {
    beforeEach(() => {
      mockQueryOne.mockResolvedValue(undefined);
    });

    it('spec_generation defaults to native runtime, claude-cli provider', async () => {
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

    it('pipeline_execution defaults to claude runtime, claude-cli provider', async () => {
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

    it('memory_consolidation defaults to native runtime, claude-cli provider', async () => {
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

    it('unknown workflow_id defaults to native runtime', async () => {
      const result = await resolveWorkflowConfig('unknown_workflow');

      expect(result.runtime).toBe('native');
      expect(result.provider).toBe('claude-cli');
    });
  });

  // ── API key resolution ────────────────────────────────────────────────

  describe('API key resolution', () => {
    it('returns vault key when userId is provided and vault has a key', async () => {
      mockQueryOne.mockResolvedValueOnce({
        workflow_id: 'spec_generation',
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'anthropic/claude-opus-4-6',
      });
      mockGetVaultKey.mockResolvedValueOnce({
        key: 'sk-ant-test-key',
        baseUrl: 'https://custom.api.example.com',
      });

      const result = await resolveWorkflowConfig('spec_generation', 'user-123');

      expect(result.apiKey).toBe('sk-ant-test-key');
      expect(result.baseUrl).toBe('https://custom.api.example.com');
      expect(mockGetVaultKey).toHaveBeenCalledWith('user-123', 'anthropic');
    });

    it('falls back to env var when vault has no key', async () => {
      mockQueryOne.mockResolvedValueOnce({
        workflow_id: 'spec_generation',
        runtime: 'opencode',
        provider: 'openrouter',
        model: 'openrouter/auto',
      });
      mockGetVaultKey.mockResolvedValueOnce(null);
      process.env.OPENROUTER_API_KEY = 'sk-or-env-key';

      const result = await resolveWorkflowConfig('spec_generation', 'user-123');

      expect(result.apiKey).toBe('sk-or-env-key');
      expect(result.baseUrl).toBeNull();
    });

    it('returns null apiKey when no vault key and no env var', async () => {
      mockQueryOne.mockResolvedValueOnce({
        workflow_id: 'spec_generation',
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'anthropic/claude-opus-4-6',
      });
      mockGetVaultKey.mockResolvedValueOnce(null);

      const result = await resolveWorkflowConfig('spec_generation', 'user-123');

      expect(result.apiKey).toBeNull();
      expect(result.baseUrl).toBeNull();
    });

    it('claude-cli runtime returns null apiKey without error', async () => {
      mockQueryOne.mockResolvedValueOnce({
        workflow_id: 'pipeline_execution',
        runtime: 'claude',
        provider: 'claude-cli',
        model: null,
      });

      const result = await resolveWorkflowConfig('pipeline_execution', 'user-123');

      expect(result.apiKey).toBeNull();
      expect(result.baseUrl).toBeNull();
      // Should NOT call getVaultKey at all for claude-cli
      expect(mockGetVaultKey).not.toHaveBeenCalled();
    });

    it('skips vault lookup when no userId provided', async () => {
      mockQueryOne.mockResolvedValueOnce({
        workflow_id: 'spec_generation',
        runtime: 'opencode',
        provider: 'anthropic',
        model: null,
      });
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';

      const result = await resolveWorkflowConfig('spec_generation');

      expect(result.apiKey).toBe('sk-ant-env-key');
      expect(mockGetVaultKey).not.toHaveBeenCalled();
    });

    it('handles vault key lookup failure gracefully', async () => {
      mockQueryOne.mockResolvedValueOnce({
        workflow_id: 'spec_generation',
        runtime: 'opencode',
        provider: 'anthropic',
        model: null,
      });
      mockGetVaultKey.mockRejectedValueOnce(new Error('vault table missing'));
      process.env.ANTHROPIC_API_KEY = 'sk-ant-fallback';

      const result = await resolveWorkflowConfig('spec_generation', 'user-123');

      expect(result.apiKey).toBe('sk-ant-fallback');
    });

    it('resolves OPENAI_API_KEY for openai-compat provider', async () => {
      mockQueryOne.mockResolvedValueOnce({
        workflow_id: 'spec_generation',
        runtime: 'opencode',
        provider: 'openai-compat',
        model: 'openai/gpt-4o',
      });
      process.env.OPENAI_API_KEY = 'sk-openai-test';

      const result = await resolveWorkflowConfig('spec_generation');

      expect(result.apiKey).toBe('sk-openai-test');
    });
  });

  // ── DB error resilience ───────────────────────────────────────────────

  describe('error resilience', () => {
    it('gracefully handles workflow_configs table not existing', async () => {
      mockQueryOne.mockRejectedValueOnce(new Error('relation "workflow_configs" does not exist'));

      const result = await resolveWorkflowConfig('pipeline_execution');

      // Should fall through to defaults
      expect(result.runtime).toBe('claude');
      expect(result.provider).toBe('claude-cli');
    });

    it('gracefully handles agent_config table not existing', async () => {
      // workflow_configs returns nothing
      mockQueryOne.mockResolvedValueOnce(undefined);
      // agent_config throws
      mockQueryOne.mockRejectedValueOnce(new Error('relation "agent_config" does not exist'));

      const result = await resolveWorkflowConfig('pipeline_execution');

      // Should fall through to defaults
      expect(result.runtime).toBe('claude');
    });
  });
});
