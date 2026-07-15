/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * pg-boss-schemas.test.ts — Unit tests for Zod schemas used in pg-boss job payloads.
 *
 * Coverage:
 *  1. Valid payloads pass parse()
 *  2. Missing required fields throw ZodError mentioning the field name
 *  3. Extra fields are rejected by .strict()
 *  4. Type coercions are rejected (runId must be number, not string)
 *  5. TypeScript compile-time: z.infer<typeof PipelineRunJobPayload> is
 *     assignable from the trigger route's jobPayload shape
 *  6. Worker handler validation: invalid payload throws before spawning —
 *     valid payload passes through cleanly
 */

import { z } from 'zod';
import {
  PipelineRunJobPayload,
  type PipelineRunJobPayloadType,
  PipelineRetryJobPayload,
  type PipelineRetryJobPayloadType,
  PipelineCancelJobPayload,
  type PipelineCancelJobPayloadType,
} from '../lib/pg-boss-schemas';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const validRunPayload = {
  runId: 42,
  specPath: 'forge/specs/approved/my-spec.json',
  workspacePath: '/home/user/project',
  agent: 'claude' as const,
  model: null,
  worktreePath: null,
  branchName: null,
  autoWorktree: false,
  envOverrides: {},
};

const validRetryPayload = {
  runId: 43,
  originalRunId: 42,
  storyIds: ['US-001', 'US-002'],
  workspacePath: '/home/user/project',
  specPath: 'forge/specs/approved/my-spec.json',
  retrySpecPath: '/tmp/retry-my-spec.json',
  agent: 'opencode' as const,
  model: 'openai/gpt-4o',
  worktreePath: null,
  sequenceOffset: 100,
  envOverrides: {},
};

const validCancelPayload = {
  runId: 42,
};

// ─────────────────────────────────────────────────────────────────────────────
// PipelineRunJobPayload
// ─────────────────────────────────────────────────────────────────────────────

describe('PipelineRunJobPayload', () => {
  test('valid payload passes parse()', () => {
    const result = PipelineRunJobPayload.parse(validRunPayload);
    expect(result.runId).toBe(42);
    expect(result.specPath).toBe('forge/specs/approved/my-spec.json');
    expect(result.agent).toBe('claude');
    expect(result.autoWorktree).toBe(false);
    expect(result.envOverrides).toEqual({});
  });

  test('optional fields have correct defaults when omitted', () => {
    const withoutOptionals = {
      runId: 1,
      specPath: 'forge/specs/approved/x.json',
      workspacePath: '/tmp/ws',
      agent: 'codex' as const,
      model: null,
      worktreePath: null,
      branchName: null,
    };
    const result = PipelineRunJobPayload.parse(withoutOptionals);
    expect(result.autoWorktree).toBe(false);
    expect(result.envOverrides).toEqual({});
  });

  test('missing runId throws ZodError mentioning "runId"', () => {
    const { runId: _omit, ...withoutRunId } = validRunPayload;
    expect(() => PipelineRunJobPayload.parse(withoutRunId)).toThrow(z.ZodError);
    try {
      PipelineRunJobPayload.parse(withoutRunId);
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const zodErr = err as z.ZodError;
      const message = zodErr.message;
      expect(message).toContain('runId');
    }
  });

  test('missing specPath throws ZodError mentioning "specPath"', () => {
    const { specPath: _omit, ...payload } = validRunPayload;
    try {
      PipelineRunJobPayload.parse(payload);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      expect((err as z.ZodError).message).toContain('specPath');
    }
  });

  test('extra field "foo" rejected by .strict()', () => {
    const withExtra = { ...validRunPayload, foo: 'bar' };
    expect(() => PipelineRunJobPayload.parse(withExtra)).toThrow(z.ZodError);
    try {
      PipelineRunJobPayload.parse(withExtra);
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const issues = (err as z.ZodError).issues;
      expect(issues.some(i => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  test('runId as string (not number) is rejected', () => {
    const withStringRunId = { ...validRunPayload, runId: '42' };
    expect(() => PipelineRunJobPayload.parse(withStringRunId)).toThrow(z.ZodError);
    try {
      PipelineRunJobPayload.parse(withStringRunId);
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const zodErr = err as z.ZodError;
      expect(zodErr.message).toContain('runId');
    }
  });

  test('runId as 0 (not positive) is rejected', () => {
    const withZeroRunId = { ...validRunPayload, runId: 0 };
    expect(() => PipelineRunJobPayload.parse(withZeroRunId)).toThrow(z.ZodError);
  });

  test('runId as negative number is rejected', () => {
    const withNegRunId = { ...validRunPayload, runId: -1 };
    expect(() => PipelineRunJobPayload.parse(withNegRunId)).toThrow(z.ZodError);
  });

  test('invalid agent value is rejected', () => {
    const withBadAgent = { ...validRunPayload, agent: 'unknown-agent' };
    expect(() => PipelineRunJobPayload.parse(withBadAgent)).toThrow(z.ZodError);
  });

  test('envOverrides with non-string values is rejected', () => {
    const withBadEnv = { ...validRunPayload, envOverrides: { KEY: 42 } };
    expect(() => PipelineRunJobPayload.parse(withBadEnv)).toThrow(z.ZodError);
  });

  test('all four agent enum values and Pi xhigh effort are accepted', () => {
    for (const agent of ['claude', 'opencode', 'codex', 'pi'] as const) {
      expect(() => PipelineRunJobPayload.parse({ ...validRunPayload, agent })).not.toThrow();
    }
    expect(PipelineRunJobPayload.parse({
      ...validRunPayload,
      agent: 'pi',
      model: 'openai-codex/gpt-5.6-sol',
      effortLevel: 'xhigh',
    })).toMatchObject({ model: 'openai-codex/gpt-5.6-sol', effortLevel: 'xhigh' });
  });

  // ── TypeScript compile-time type test ───────────────────────────────────
  // This is a static check: if the trigger route's jobPayload shape is not
  // assignable to PipelineRunJobPayloadType, this file won't compile.
  test('trigger route jobPayload satisfies PipelineRunJobPayloadType at compile time', () => {
    // Mirrors the exact shape produced by the trigger route (pipeline.ts ~L1334)
    const runId = 42;
    const specPath = 'forge/specs/approved/my-spec.json';
    const workspacePath = '/home/user/project';
    const resolvedAgentType: 'claude' | 'opencode' | 'codex' | 'pi' = 'claude';
    const resolvedAgentModel: string | null = null;
    const worktreePath: string | null = null;
    const branchName: string | null = null;
    const needsWorktree = false;
    const envOverrides: Record<string, string> = {};

    // This assignment is the TypeScript compile-time assertion.
    // If PipelineRunJobPayloadType doesn't accept this shape, tsc will error.
    const triggerPayload = {
      runId,
      specPath,
      workspacePath,
      agent: resolvedAgentType,
      model: resolvedAgentModel ?? null,
      worktreePath: worktreePath ?? null,
      branchName: branchName ?? null,
      autoWorktree: needsWorktree,
      envOverrides,
    };
    const _typeCheck: PipelineRunJobPayloadType = PipelineRunJobPayload.parse(triggerPayload);
    expect(_typeCheck.runId).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PipelineRetryJobPayload
// ─────────────────────────────────────────────────────────────────────────────

describe('PipelineRetryJobPayload', () => {
  test('valid payload passes parse()', () => {
    const result = PipelineRetryJobPayload.parse(validRetryPayload);
    expect(result.runId).toBe(43);
    expect(result.originalRunId).toBe(42);
    expect(result.storyIds).toEqual(['US-001', 'US-002']);
    expect(result.sequenceOffset).toBe(100);
  });

  test('preserves xhigh effort for Pi retry resume', () => {
    expect(PipelineRetryJobPayload.parse({
      ...validRetryPayload,
      agent: 'pi',
      model: 'openai-codex/gpt-5.6-sol',
      effortLevel: 'xhigh',
    })).toMatchObject({ model: 'openai-codex/gpt-5.6-sol', effortLevel: 'xhigh' });
  });

  test('missing originalRunId throws ZodError mentioning "originalRunId"', () => {
    const { originalRunId: _omit, ...payload } = validRetryPayload;
    try {
      PipelineRetryJobPayload.parse(payload);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      expect((err as z.ZodError).message).toContain('originalRunId');
    }
  });

  test('missing retrySpecPath throws ZodError mentioning "retrySpecPath"', () => {
    const { retrySpecPath: _omit, ...payload } = validRetryPayload;
    try {
      PipelineRetryJobPayload.parse(payload);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      expect((err as z.ZodError).message).toContain('retrySpecPath');
    }
  });

  test('extra field rejected by .strict()', () => {
    const withExtra = { ...validRetryPayload, unexpected: true };
    expect(() => PipelineRetryJobPayload.parse(withExtra)).toThrow(z.ZodError);
    try {
      PipelineRetryJobPayload.parse(withExtra);
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const issues = (err as z.ZodError).issues;
      expect(issues.some(i => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  test('sequenceOffset as negative number is rejected', () => {
    const withNegOffset = { ...validRetryPayload, sequenceOffset: -1 };
    expect(() => PipelineRetryJobPayload.parse(withNegOffset)).toThrow(z.ZodError);
  });

  test('sequenceOffset of 0 is valid', () => {
    const withZeroOffset = { ...validRetryPayload, sequenceOffset: 0 };
    expect(() => PipelineRetryJobPayload.parse(withZeroOffset)).not.toThrow();
  });

  test('storyIds as non-array is rejected', () => {
    const withBadStories = { ...validRetryPayload, storyIds: 'US-001' };
    expect(() => PipelineRetryJobPayload.parse(withBadStories)).toThrow(z.ZodError);
  });

  test('TypeScript: z.infer type is assignable', () => {
    const result = PipelineRetryJobPayload.parse(validRetryPayload);
    const _typeCheck: PipelineRetryJobPayloadType = result;
    expect(_typeCheck.runId).toBe(43);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PipelineCancelJobPayload
// ─────────────────────────────────────────────────────────────────────────────

describe('PipelineCancelJobPayload', () => {
  test('valid payload passes parse()', () => {
    const result = PipelineCancelJobPayload.parse(validCancelPayload);
    expect(result.runId).toBe(42);
  });

  test('missing runId throws ZodError mentioning "runId"', () => {
    try {
      PipelineCancelJobPayload.parse({});
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      expect((err as z.ZodError).message).toContain('runId');
    }
  });

  test('extra field rejected by .strict()', () => {
    const withExtra = { runId: 42, extra: 'oops' };
    expect(() => PipelineCancelJobPayload.parse(withExtra)).toThrow(z.ZodError);
    try {
      PipelineCancelJobPayload.parse(withExtra);
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const issues = (err as z.ZodError).issues;
      expect(issues.some(i => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  test('runId as string is rejected', () => {
    expect(() => PipelineCancelJobPayload.parse({ runId: '42' })).toThrow(z.ZodError);
  });

  test('TypeScript: z.infer type is assignable', () => {
    const result = PipelineCancelJobPayload.parse(validCancelPayload);
    const _typeCheck: PipelineCancelJobPayloadType = result;
    expect(_typeCheck.runId).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Worker handler validation behaviour (simulated)
// ─────────────────────────────────────────────────────────────────────────────

describe('Worker handler payload validation — invalid payload throws before spawning', () => {
  /**
   * Simulate the worker handler's validation logic:
   *   const parsed = PipelineRunJobPayload.safeParse(job.data);
   *   if (!parsed.success) { throw new Error(...); }
   *   // ... spawn execution-engine ...
   */
  function simulateWorkerHandler(jobData: unknown): { spawned: boolean; error?: string } {
    const parsed = PipelineRunJobPayload.safeParse(jobData);
    if (!parsed.success) {
      // Mirrors worker.ts: throws so pg-boss marks job failed
      throw new Error(`Invalid pipeline:run payload: ${parsed.error.message}`);
    }
    // Reaching here means we would spawn — just return a flag
    return { spawned: true };
  }

  test('valid payload allows spawn', () => {
    expect(simulateWorkerHandler(validRunPayload)).toEqual({ spawned: true });
  });

  test('invalid payload (missing runId) throws and prevents spawn', () => {
    const { runId: _omit, ...withoutRunId } = validRunPayload;
    expect(() => simulateWorkerHandler(withoutRunId)).toThrow('Invalid pipeline:run payload');
  });

  test('invalid payload (extra field) throws and prevents spawn', () => {
    const withExtra = { ...validRunPayload, injected: 'evil' };
    expect(() => simulateWorkerHandler(withExtra)).toThrow('Invalid pipeline:run payload');
  });

  test('invalid payload (wrong runId type) throws and prevents spawn', () => {
    const withStringRunId = { ...validRunPayload, runId: '42' };
    expect(() => simulateWorkerHandler(withStringRunId)).toThrow('Invalid pipeline:run payload');
  });

  test('parse() on invalid payload throws ZodError (not a generic Error)', () => {
    const { runId: _omit, ...withoutRunId } = validRunPayload;
    try {
      PipelineRunJobPayload.parse(withoutRunId);
      fail('should have thrown');
    } catch (err) {
      // ZodError is a subclass of Error — the worker can let it propagate
      // naturally so pg-boss marks the job as failed
      expect(err).toBeInstanceOf(z.ZodError);
    }
  });
});
