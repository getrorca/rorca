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
import {
  ShellCommandContextEventPayload,
  AgentCliSessionContextEventPayload,
  IdeSessionContextEventPayload,
  EditorActivityContextEventPayload,
  ExplicitMemoryContextEventPayload,
  GitCommitContextEventPayload,
  CiPrContextEventPayload,
  ContextCaptureEventJobPayload,
  ContextEventIdempotencyGuidance,
  CONTEXT_EVENT_PAYLOAD_SCHEMA_VERSION,
  TrustTierEnum,
  deriveContextEventIdempotencyKey,
} from '../lib/context-capture-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const validRunPayload = {
  runId: 42,
  specPath: 'forge/specs/approved/my-spec.json',
  runSpecPath: '/home/user/project/.rorca/run-specs/run-42.json',
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
  scopeHash: `sha256:${'a'.repeat(64)}`,
  previewHash: `sha256:${'b'.repeat(64)}`,
  approvedPreview: { schemaVersion: 'retry-preview.v1' },
  generatedPlanHash: `sha256:${'c'.repeat(64)}`,
  dispatchIdentity: { schemaVersion: 'rorca.governed-retry-dispatch.v1', identityHash: `sha256:${'d'.repeat(64)}` },
  workspacePath: '/home/user/project',
  specPath: 'forge/specs/approved/my-spec.json',
  runSpecPath: '/home/user/project/.rorca/run-specs/retry-43.json',
  retrySpecPath: '/home/user/project/.rorca/run-specs/retry-43.json',
  agent: 'opencode' as const,
  model: 'openai/gpt-4o',
  worktreePath: null,
  branchName: null,
  terminalMode: 'ansi-html' as const,
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
      runSpecPath: '/tmp/ws/.rorca/run-specs/run-1.json',
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

  test('runId accepts a numeric queue representation but rejects non-numeric input', () => {
    expect(PipelineRunJobPayload.parse({ ...validRunPayload, runId: '42' }).runId).toBe(42);
    expect(() => PipelineRunJobPayload.parse({ ...validRunPayload, runId: 'not-a-run' })).toThrow(z.ZodError);
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
      runSpecPath: '/home/user/project/.rorca/run-specs/run-42.json',
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

  test('runId accepts a numeric queue representation but rejects non-numeric input', () => {
    expect(PipelineCancelJobPayload.parse({ runId: '42' }).runId).toBe(42);
    expect(() => PipelineCancelJobPayload.parse({ runId: 'not-a-run' })).toThrow(z.ZodError);
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

  test('invalid payload (non-numeric runId) throws and prevents spawn', () => {
    const withStringRunId = { ...validRunPayload, runId: 'not-a-run' };
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

// ─────────────────────────────────────────────────────────────────────────────
// Context capture event payloads
// ─────────────────────────────────────────────────────────────────────────────

describe('Context capture event schemas', () => {
  const sourceIdentity = {
    source_system: 'shell' as const,
    tool_name: 'shell',
    host_application: null,
    session_id: 'session-1',
    workspace_id: 'rorca',
    repo_path_hash: `sha256:${'1'.repeat(64)}`,
  };

  const common = {
    payload_schema_version: CONTEXT_EVENT_PAYLOAD_SCHEMA_VERSION,
    source_identity: sourceIdentity,
    source_system: 'shell' as const,
    tool_name: 'shell',
    host_application: null,
    session_id: 'session-1',
    workspace_id: 'rorca',
    repo_path_hash: `sha256:${'1'.repeat(64)}`,
    git_branch: 'main',
    git_sha: 'b'.repeat(40),
    related_files: [{ path: 'src/index.ts', role: 'mentioned' as const, hash: null }],
    capture_policy: { policy_version: '2026-07-ucc-007', mode: 'metadata-only' as const, raw_content: 'summary' as const },
    trust_tier: 'local' as const,
    provenance: { capture_source: 'shellIntegration' as const, source_event_id: 'event-1', adapter_version: null, emitted_at: '2026-07-05T00:00:00.000Z', received_at: null, local_only: true },
  };

  const basePayload = {
    ...common,
    idempotency_key: deriveContextEventIdempotencyKey({ eventType: 'shell_command', source_system: 'shell', session_id: 'session-1', workspace_id: 'rorca', occurred_at: '2026-07-05T00:00:00.000Z', phase: 'end', command_hash: 'a'.repeat(64), exit_code: 0 }),
    phase: 'end' as const,
    policyMode: 'metadata-only' as const,
    command_summary: 'claude --print [REDACTED]',
    command_hash: 'a'.repeat(64),
    cwd: '/workspace',
    exit_code: 0,
    duration_ms: 123,
    agent: { recognized: false, binary: 'unknown' as const, matchedPattern: null },
    regulated_signals: [],
  };

  const safety = {
    contextSafetyModule: 'backend/src/lib/context-safety.ts' as const,
    policyVersion: '2026-07-ucc-007',
    redactionCount: 1,
    ignoredPathCount: 0,
    truncated: false,
    hashAlgorithm: 'sha256' as const,
    contentHash: 'c'.repeat(64),
  };

  test('shell_command accepts unknown commands at metadata level', () => {
    const parsed = ShellCommandContextEventPayload.parse({
      ...basePayload,
      eventType: 'shell_command',
      idempotency_key: deriveContextEventIdempotencyKey({ eventType: 'shell_command', source_system: 'shell', session_id: 'session-1', workspace_id: 'rorca', occurred_at: '2026-07-05T00:00:00.000Z', phase: 'end', command_hash: 'a'.repeat(64), exit_code: 0 }),
      policyMode: 'metadata-only',
      command_summary: null,
    });
    expect(parsed.command_summary).toBeNull();
    expect(parsed.agent.binary).toBe('unknown');
    expect(parsed.eventType).toBe('shell_command');
  });

  test('agent_cli_session requires recognized agent binary', () => {
    const parsed = AgentCliSessionContextEventPayload.parse({
      ...basePayload,
      eventType: 'agent_cli_session',
      idempotency_key: deriveContextEventIdempotencyKey({ eventType: 'agent_cli_session', source_system: 'shell', tool_name: 'claude', session_id: 'session-1', workspace_id: 'rorca', occurred_at: '2026-07-05T00:00:00.000Z', command_hash: 'a'.repeat(64) }),
      tool_name: 'claude',
      source_identity: { ...sourceIdentity, tool_name: 'claude' },
      agent: { recognized: true, binary: 'claude', matchedPattern: 'claude' },
    });
    expect(parsed.agent.binary).toBe('claude');
    expect(() => AgentCliSessionContextEventPayload.parse({ ...parsed, agent: { recognized: false, binary: 'unknown' } })).toThrow(z.ZodError);
  });

  test('all required UCC-007 event payload schemas parse nullable fields and provenance', () => {
    expect(IdeSessionContextEventPayload.parse({
      ...common,
      eventType: 'ide_session',
      idempotency_key: deriveContextEventIdempotencyKey({ eventType: 'ide_session', source_system: 'vscode', host_application: 'vscode', session_id: 'session-1', workspace_id: 'rorca', occurred_at: '2026-07-05T00:00:00.000Z' }),
      source_system: 'vscode',
      host_application: 'vscode',
      source_identity: { ...sourceIdentity, source_system: 'vscode', host_application: 'vscode' },
      git_sha: null,
      ide_session_state: 'started',
      workspace_folders: ['/workspace'],
      extension_version: null,
    }).extension_version).toBeNull();

    expect(EditorActivityContextEventPayload.parse({
      ...common,
      eventType: 'editor_activity',
      idempotency_key: deriveContextEventIdempotencyKey({ eventType: 'editor_activity', source_system: 'vscode', host_application: 'vscode', session_id: 'session-1', workspace_id: 'rorca', occurred_at: '2026-07-05T00:00:00.000Z', activity_type: 'save', related_files: [{ path: 'src/index.ts' }] }),
      source_system: 'vscode',
      host_application: 'vscode',
      source_identity: { ...sourceIdentity, source_system: 'vscode', host_application: 'vscode' },
      activity_type: 'save',
      document_uri_hash: null,
      language_id: 'typescript',
      summary: null,
    }).document_uri_hash).toBeNull();

    expect(ExplicitMemoryContextEventPayload.parse({
      ...common,
      eventType: 'explicit_memory',
      idempotency_key: deriveContextEventIdempotencyKey({ eventType: 'explicit_memory', source_system: 'pi', tool_name: 'pi', session_id: 'session-1', workspace_id: 'rorca', occurred_at: '2026-07-05T00:00:00.000Z', memory_hash: `sha256:${'d'.repeat(64)}` }),
      source_system: 'pi',
      tool_name: 'pi',
      source_identity: { ...sourceIdentity, source_system: 'pi', tool_name: 'pi' },
      memory_hash: `sha256:${'d'.repeat(64)}`,
      memory_summary: 'Remember contract decisions.',
      category: null,
      requested_by: 'human',
    }).category).toBeNull();

    expect(GitCommitContextEventPayload.parse({
      ...common,
      eventType: 'git_commit',
      idempotency_key: deriveContextEventIdempotencyKey({ eventType: 'git_commit', source_system: 'repo_daemon', workspace_id: 'rorca', git_sha: 'abc1234' }),
      source_system: 'repo_daemon',
      source_identity: { ...sourceIdentity, source_system: 'repo_daemon' },
      git_sha: 'abc1234',
      commit_subject: null,
      committed_at: null,
      author_hash: null,
      changed_files: [],
    }).git_sha).toBe('abc1234');

    expect(CiPrContextEventPayload.parse({
      ...common,
      eventType: 'ci_pr',
      idempotency_key: deriveContextEventIdempotencyKey({ eventType: 'ci_pr', source_system: 'ci', workspace_id: 'rorca', provider: 'github', repository: 'rorca/rorca', pr_number: 12, head_sha: 'def5678', run_id: 'run-1' }),
      source_system: 'ci',
      source_identity: { ...sourceIdentity, source_system: 'ci' },
      provider: 'github',
      repository: 'rorca/rorca',
      pr_number: 12,
      head_sha: 'def5678',
      base_branch: null,
      status: 'running',
      run_id: 'run-1',
    }).pr_number).toBe('12');
  });

  test('capture-event trust vocabulary remains provenance-only and cannot imply approved memory authority', () => {
    expect(TrustTierEnum.options).toEqual(['untrusted', 'local', 'verified', 'privileged']);
  });

  test('every UCC-007 event type has deterministic idempotency guidance', () => {
    expect(Object.keys(ContextEventIdempotencyGuidance).sort()).toEqual(['agent_cli_session', 'ci_pr', 'editor_activity', 'explicit_memory', 'git_commit', 'ide_session', 'shell_command'].sort());
    expect(ContextEventIdempotencyGuidance.git_commit).toContain('git_sha');
    expect(ContextEventIdempotencyGuidance.shell_command).toContain('command_hash');
    expect(deriveContextEventIdempotencyKey({ eventType: 'git_commit', source_system: 'repo_daemon', workspace_id: 'rorca', git_sha: 'abc1234' })).toBe(
      deriveContextEventIdempotencyKey({ eventType: 'git_commit', source_system: 'repo_daemon', workspace_id: 'rorca', git_sha: 'abc1234' }),
    );
  });

  test('context capture job payload is strict and includes safety report', () => {
    const event = ContextCaptureEventJobPayload.parse({
      workspaceId: 'rorca',
      source: 'shellIntegration',
      occurredAt: '2026-07-05T00:00:00.000Z',
      payload: { ...basePayload, eventType: 'shell_command' },
      safety,
    });
    expect(event.payload.eventType).toBe('shell_command');
    expect(() => ContextCaptureEventJobPayload.parse({ ...event, directDbWrite: true })).toThrow(z.ZodError);
  });
});
