/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { distillContextEventToCandidate, isCandidateVisibleInDefaultRetrieval } from '../context-distillation';
import type { UnifiedContextEventPayloadType } from '../pg-boss-schemas';

const base = {
  payload_schema_version: '2026-07-ucc-007.v1',
  source_identity: {
    source_system: 'shell',
    tool_name: 'shell',
    host_application: null,
    session_id: 'session-1',
    workspace_id: 'rorca',
    repo_path_hash: 'sha256:repo',
  },
  source_system: 'shell',
  tool_name: 'shell',
  host_application: null,
  session_id: 'session-1',
  workspace_id: 'rorca',
  repo_path_hash: 'sha256:repo',
  git_branch: 'main',
  git_sha: 'abc1234',
  related_files: [{ path: 'backend/src/lib/context-safety.ts', role: 'mentioned', hash: null }],
  capture_policy: { policy_version: '2026-07-ucc-007', mode: 'command-summary', raw_content: 'summary' },
  trust_tier: 'local',
  idempotency_key: `sha256:${'a'.repeat(64)}`,
  provenance: {
    capture_source: 'shellIntegration',
    source_event_id: 'source-event-1',
    adapter_version: null,
    emitted_at: '2026-07-06T00:00:00.000Z',
    received_at: '2026-07-06T00:00:01.000Z',
    local_only: true,
  },
} as const;

function shell(overrides: Partial<UnifiedContextEventPayloadType> = {}): UnifiedContextEventPayloadType {
  return {
    ...base,
    eventType: 'shell_command',
    phase: 'end',
    policyMode: 'command-summary',
    command_summary: 'Rorca convention: use apiFetch for frontend API calls and never raw fetch.',
    command_hash: 'cmd-hash-1'.padEnd(16, '0'),
    cwd: '/repo',
    exit_code: 0,
    duration_ms: 100,
    agent: { recognized: false, binary: 'unknown', matchedPattern: null },
    regulated_signals: [],
    ...overrides,
  } as UnifiedContextEventPayloadType;
}

describe('context event memory distillation', () => {
  test('creates pending candidates from explicit agent memory with provenance and related files', () => {
    const payload = {
      ...base,
      eventType: 'explicit_memory',
      source_system: 'pi',
      tool_name: 'pi',
      source_identity: { ...base.source_identity, source_system: 'pi', tool_name: 'pi' },
      memory_hash: 'memory-hash-123456',
      memory_summary: 'Decision: keep pg-boss queue creation explicit before send or work.',
      category: 'Decision',
      requested_by: 'agent',
    } as unknown as UnifiedContextEventPayloadType;

    const candidate = distillContextEventToCandidate({ eventId: 42, occurredAt: '2026-07-06T00:00:00.000Z', payload, safetyContentHash: 'hash-1', mode: 'explicit-only' });

    expect(candidate).not.toBeNull();
    expect(candidate?.status).toBe('pending');
    expect(candidate?.defaultRetrievalEligible).toBe(false);
    expect(candidate?.provenance).toMatchObject({ sourceContextEventId: 42, sourceEventId: 'source-event-1', sourceTool: 'pi', sourceSessionId: 'session-1' });
    expect(candidate?.relatedFiles).toContain('backend/src/lib/context-safety.ts');
    expect(candidate?.evidenceSnippets[0].text).toContain('pg-boss queue creation');
  });

  test('skips routine shell noise', () => {
    const candidate = distillContextEventToCandidate({ eventId: 43, payload: shell({ command_summary: 'git status' } as Partial<UnifiedContextEventPayloadType>), safetyContentHash: 'hash-2' });
    expect(candidate).toBeNull();
  });

  test('creates review-required candidates and redacts secrets from shell evidence', () => {
    const payload = shell({
      command_summary: 'Gotcha: token=supersecretvalue12345678901234567890 must be loaded from the vault instead of CLI args.',
      regulated_signals: ['possible_credit_card'],
    } as Partial<UnifiedContextEventPayloadType>);

    const candidate = distillContextEventToCandidate({ eventId: 44, payload, safetyContentHash: 'hash-3' });

    expect(candidate).not.toBeNull();
    expect(candidate?.status).toBe('review_required');
    expect(candidate?.securitySensitive).toBe(true);
    expect(candidate?.reviewReason).toBe('security_or_regulated_signal_requires_explicit_review');
    expect(candidate?.content).toContain('[REDACTED_SECRET_ASSIGNMENT]');
    expect(candidate?.content).not.toContain('supersecretvalue');
    expect(candidate?.evidenceSnippets[0].redacted).toBe(true);
  });

  test('distills durable daemon and IDE summaries but preserves pending retrieval guard', () => {
    const payload = {
      ...base,
      eventType: 'editor_activity',
      source_system: 'daemon',
      tool_name: 'repo-daemon',
      source_identity: { ...base.source_identity, source_system: 'daemon', tool_name: 'repo-daemon' },
      activity_type: 'diagnostic',
      document_uri_hash: 'doc-hash',
      language_id: 'typescript',
      summary: 'Architecture: context event distillation must write memory_candidates, not memories, until approval.',
    } as unknown as UnifiedContextEventPayloadType;

    const candidate = distillContextEventToCandidate({ eventId: 45, payload, safetyContentHash: 'hash-4' });

    expect(candidate).not.toBeNull();
    expect(candidate?.category).toBe('Architecture');
    expect(candidate?.status).toBe('pending');
    expect(isCandidateVisibleInDefaultRetrieval(candidate!.status)).toBe(false);
  });

  test('deduplicates one canonical event across repeated source-session delivery while separating event identities', () => {
    const payload = shell();
    const a = distillContextEventToCandidate({ eventId: 46, payload, safetyContentHash: 'hash-5' });
    const b = distillContextEventToCandidate({ eventId: 46, payload, safetyContentHash: 'hash-5' });
    const c = distillContextEventToCandidate({ eventId: 46, payload: shell({ session_id: 'session-2', source_identity: { ...base.source_identity, session_id: 'session-2' } } as Partial<UnifiedContextEventPayloadType>), safetyContentHash: 'hash-5' });
    const d = distillContextEventToCandidate({ eventId: 47, payload, safetyContentHash: 'hash-5' });

    expect(a?.dedupeKey).toBe(b?.dedupeKey);
    expect(a?.dedupeKey).toBe(c?.dedupeKey);
    expect(a?.dedupeKey).not.toBe(d?.dedupeKey);
  });

  test('only approved candidates are considered default retrieval eligible', () => {
    expect(isCandidateVisibleInDefaultRetrieval('pending')).toBe(false);
    expect(isCandidateVisibleInDefaultRetrieval('review_required')).toBe(false);
    expect(isCandidateVisibleInDefaultRetrieval('approved')).toBe(true);
    expect(isCandidateVisibleInDefaultRetrieval('auto_approved')).toBe(true);
  });
});
