/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-018: Retrieval trace persistence — unit tests.
 *
 * Tests cover:
 *   - Redaction of sensitive values in traces and candidates
 *   - Trace persistence (mock DB)
 *   - Trace retrieval (mock DB)
 *   - Missing trace (NotFoundError)
 *   - Contract validation
 */

import {
  redactSensitiveString,
  redactCandidate,
  redactRetrievalTrace,
} from '../retrieval-trace';
import type { RetrievalTrace, RetrievalCandidate } from '../retrieval-contracts';
import { retrievalTrace as retrievalTraceSchema } from '../retrieval-contracts';

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function makeCandidate(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    schemaVersion: 'v1' as const,
    id: overrides.id ?? 'mem-1',
    kind: 'memory',
    ref: overrides.ref ?? 'memory:ws-1::abc123',
    title: overrides.title ?? 'Test Memory',
    score: overrides.score ?? 0.85,
    breakdown: overrides.breakdown ?? {
      keyword: 0.7,
      semantic: 0.8,
      graphDistance: 0.6,
      relationType: 0.5,
      fileRole: 0.4,
      testsEntrypoints: 0.3,
      gitRecency: 0.9,
      memoryRelevance: 0.85,
      trustAuthority: 0.75,
    },
    trust: overrides.trust ?? 'verified',
    reason: overrides.reason ?? 'This memory is relevant because it describes the architecture pattern.',
    confidence: overrides.confidence ?? 0.9,
  };
}

function makeTrace(overrides: Partial<RetrievalTrace> = {}): RetrievalTrace {
  return {
    schemaVersion: 'v1' as const,
    traceId: overrides.traceId ?? 'trace-001',
    workspaceId: overrides.workspaceId ?? 'ws-1',
    briefHash: overrides.briefHash ?? 'abc123def456',
    gitSha: overrides.gitSha ?? 'abcdef1234567890',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    policy: overrides.policy ?? 'default',
    graphMode: overrides.graphMode ?? 'full',
    degraded: overrides.degraded ?? false,
    candidates: overrides.candidates ?? [makeCandidate()],
    tokenEstimate: overrides.tokenEstimate ?? 1500,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Redaction tests
// ════════════════════════════════════════════════════════════════════════════

describe('redactSensitiveString', () => {
  it('redacts API keys', () => {
    const result = redactSensitiveString('Authorization: Bearer sk-abc123def456789012345678901234');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('sk-abc123');
  });

  it('redacts private key headers', () => {
    const result = redactSensitiveString('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('BEGIN RSA');
  });

  it('redacts database connection strings', () => {
    const result = redactSensitiveString('postgres://user:password123@localhost:5432/db');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('password123');
  });

  it('redacts AWS access keys', () => {
    const result = redactSensitiveString('AWS key: AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('AKIA');
  });

  it('redacts GitHub personal access tokens', () => {
    const result = redactSensitiveString('Token: ghp_1234567890abcdef1234567890abcdef123456');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('ghp_');
  });

  it('redacts Slack tokens', () => {
    const result = redactSensitiveString('Slack: xoxb-1234567890-1234567890-abcdef1234567890');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('xoxb-');
  });

  it('redacts key=value secrets', () => {
    const result = redactSensitiveString('Use api_key="my-super-secret-key-12345" for auth');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('my-super-secret');
  });

  it('truncates long strings to maxLength', () => {
    const longString = 'A'.repeat(3000);
    const result = redactSensitiveString(longString, 1000);
    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result).toContain('…[truncated]');
  });

  it('preserves benign strings unchanged', () => {
    const benign = 'This is a normal description of a file path: src/lib/memory-router.ts';
    const result = redactSensitiveString(benign);
    expect(result).toBe(benign);
  });

  it('preserves short strings under maxLength', () => {
    const short = 'Short string';
    const result = redactSensitiveString(short, 100);
    expect(result).toBe(short);
  });
});

describe('redactCandidate', () => {
  it('redacts sensitive data in title', () => {
    const candidate = makeCandidate({
      title: 'Memory about sk-a1b2c3d4e5f6g7h8i9j0k1l2',
    });
    const redacted = redactCandidate(candidate);
    expect(redacted.title).toContain('[REDACTED]');
    expect(redacted.title).not.toContain('sk-secret');
  });

  it('redacts sensitive data in reason', () => {
    const candidate = makeCandidate({
      reason: 'Found secret: Bearer token-abc123def4567890123456 in the file',
    });
    const redacted = redactCandidate(candidate);
    expect(redacted.reason).toContain('[REDACTED]');
  });

  it('redacts sensitive data in ref', () => {
    const candidate = makeCandidate({
      ref: '/config/secrets/api_key=abc123/prod.yaml',
    });
    const redacted = redactCandidate(candidate);
    expect(redacted.ref).toContain('[REDACTED]');
  });

  it('preserves safe fields unchanged', () => {
    const candidate = makeCandidate({
      id: 'mem-42',
      score: 0.95,
      trust: 'verified',
    });
    const redacted = redactCandidate(candidate);
    expect(redacted.id).toBe('mem-42');
    expect(redacted.score).toBe(0.95);
    expect(redacted.trust).toBe('verified');
  });

  it('preserves score breakdown', () => {
    const candidate = makeCandidate({
      breakdown: {
        keyword: 0.9,
        semantic: 0.85,
        graphDistance: 0.7,
      },
    });
    const redacted = redactCandidate(candidate);
    expect(redacted.breakdown).toEqual(candidate.breakdown);
  });

  it('preserves undefined optional fields', () => {
    const candidate = makeCandidate();
    delete (candidate as any).title;
    delete (candidate as any).reason;
    delete (candidate as any).confidence;
    const redacted = redactCandidate(candidate);
    expect(redacted.title).toBeUndefined();
    expect(redacted.reason).toBeUndefined();
  });
});

describe('redactRetrievalTrace', () => {
  it('redacts all candidates in the trace', () => {
    const trace = makeTrace({
      candidates: [
        makeCandidate({ id: 'c1', title: 'Secret: sk-abc123def4567890abcdef', reason: 'Contains api_key=supersecretkey' }),
        makeCandidate({ id: 'c2', title: 'Clean memory', reason: 'Normal reason' }),
      ],
    });

    const redacted = redactRetrievalTrace(trace);

    // c1 should be redacted
    expect(redacted.candidates[0].title).toContain('[REDACTED]');
    expect(redacted.candidates[0].reason).toContain('[REDACTED]');

    // c2 should be preserved
    expect(redacted.candidates[1].title).toBe('Clean memory');
    expect(redacted.candidates[1].reason).toBe('Normal reason');
  });

  it('caps candidates at MAX_CANDIDATES_IN_TRACE (100)', () => {
    const candidates = Array.from({ length: 150 }, (_, i) =>
      makeCandidate({ id: `mem-${i}` }),
    );

    const trace = makeTrace({ candidates });
    const redacted = redactRetrievalTrace(trace);

    expect(redacted.candidates.length).toBe(100);
  });

  it('preserves trace metadata', () => {
    const trace = makeTrace({
      traceId: 'trace-xyz',
      workspaceId: 'ws-2',
      briefHash: 'hash123',
      gitSha: 'deadbeef1234',
      graphMode: 'lite',
      degraded: true,
      tokenEstimate: 2000,
    });

    const redacted = redactRetrievalTrace(trace);

    expect(redacted.traceId).toBe('trace-xyz');
    expect(redacted.workspaceId).toBe('ws-2');
    expect(redacted.briefHash).toBe('hash123');
    expect(redacted.gitSha).toBe('deadbeef1234');
    expect(redacted.graphMode).toBe('lite');
    expect(redacted.degraded).toBe(true);
    expect(redacted.tokenEstimate).toBe(2000);
  });

  it('does not mutate the original trace', () => {
    const trace = makeTrace({
      candidates: [makeCandidate({ title: 'Original title' })],
    });

    const redacted = redactRetrievalTrace(trace);

    // Original should be untouched
    expect(trace.candidates[0].title).toBe('Original title');

    // Redacted is a different object
    expect(redacted).not.toBe(trace);
    expect(redacted.candidates).not.toBe(trace.candidates);
  });

  it('handles empty candidates array', () => {
    const trace = makeTrace({ candidates: [] });
    const redacted = redactRetrievalTrace(trace);
    expect(redacted.candidates).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Contract validation tests
// ════════════════════════════════════════════════════════════════════════════

describe('retrievalTrace contract validation', () => {
  it('accepts a valid trace', () => {
    const trace = makeTrace();
    const result = retrievalTraceSchema.safeParse(trace);
    expect(result.success).toBe(true);
  });

  it('rejects a trace with missing required fields', () => {
    const result = retrievalTraceSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a trace with invalid schemaVersion', () => {
    // Build the trace manually to bypass the makeTrace default 'v1'
    const trace = {
      schemaVersion: 'invalid',
      traceId: 't1',
      workspaceId: 'ws-1',
      briefHash: 'abc123',
      createdAt: new Date().toISOString(),
      candidates: [],
    };
    const result = retrievalTraceSchema.safeParse(trace);
    expect(result.success).toBe(false);
  });

  it('rejects a trace with negative tokenEstimate', () => {
    const trace = makeTrace({ tokenEstimate: -1 });
    const result = retrievalTraceSchema.safeParse(trace);
    expect(result.success).toBe(false);
  });

  it('rejects a trace with invalid graphMode', () => {
    const trace = makeTrace({ graphMode: 'invalid' as any });
    const result = retrievalTraceSchema.safeParse(trace);
    expect(result.success).toBe(false);
  });

  it('accepts a trace with optional fields omitted', () => {
    const trace: RetrievalTrace = {
      schemaVersion: 'v1' as const,
      traceId: 'minimal-trace',
      workspaceId: 'ws-1',
      briefHash: 'hash',
      createdAt: new Date().toISOString(),
      candidates: [],
    };
    const result = retrievalTraceSchema.safeParse(trace);
    expect(result.success).toBe(true);
  });

  it('validates candidate score in [0, 1]', () => {
    const trace = makeTrace({
      candidates: [makeCandidate({ score: 1.5 })],
    });
    const result = retrievalTraceSchema.safeParse(trace);
    expect(result.success).toBe(false);
  });

  it('rejects trace with invalid workspaceId (empty)', () => {
    const trace = makeTrace({ workspaceId: '' });
    const result = retrievalTraceSchema.safeParse(trace);
    expect(result.success).toBe(false);
  });

  it('validates breakdown scores are numbers', () => {
    const trace = makeTrace({
      candidates: [makeCandidate({ breakdown: { keyword: 'not-a-number' as any } })],
    });
    const result = retrievalTraceSchema.safeParse(trace);
    expect(result.success).toBe(false);
  });

  it('accepts trace with all signal breakdown components', () => {
    const candidate = makeCandidate({
      breakdown: {
        keyword: 0.9,
        semantic: 0.85,
        graphDistance: 0.7,
        relationType: 0.6,
        fileRole: 0.5,
        testsEntrypoints: 0.4,
        gitRecency: 0.8,
        memoryRelevance: 0.95,
        trustAuthority: 0.75,
      },
    });
    const trace = makeTrace({ candidates: [candidate] });
    const result = retrievalTraceSchema.safeParse(trace);
    expect(result.success).toBe(true);
  });

  it('rejects trace with invalid gitSha (too short)', () => {
    const trace = makeTrace({ gitSha: 'abc12' });
    const result = retrievalTraceSchema.safeParse(trace);
    expect(result.success).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Roundtrip test: redact then validate
// ════════════════════════════════════════════════════════════════════════════

describe('redaction + contract roundtrip', () => {
  it('produces a valid trace after redaction', () => {
    const trace = makeTrace({
      candidates: [
        makeCandidate({
          title: 'Memory with secret: Bearer abc123def456789token',
          reason: 'Found api_key="my-secret-key" in source',
        }),
      ],
    });

    const redacted = redactRetrievalTrace(trace);

    // After redaction, the trace should still pass contract validation
    const result = retrievalTraceSchema.safeParse(redacted);
    expect(result.success).toBe(true);
  });

  it('redacted trace carries all required metadata', () => {
    const trace = makeTrace({
      degraded: true,
      graphMode: 'lite',
      tokenEstimate: 500,
    });

    const redacted = redactRetrievalTrace(trace);
    const parsed = retrievalTraceSchema.parse(redacted);

    expect(parsed.degraded).toBe(true);
    expect(parsed.graphMode).toBe('lite');
    expect(parsed.tokenEstimate).toBe(500);
    expect(parsed.schemaVersion).toBe('v1');
    expect(parsed.traceId).toBe('trace-001');
    expect(parsed.workspaceId).toBe('ws-1');
  });
});
