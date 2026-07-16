/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { ContextCaptureEventJobPayload, deriveContextEventIdempotencyKey } from '../context-capture-contracts';
import { __contextDistillationInternals, distillContextEventToCandidate } from '../context-distillation';
import { importExternalMemoryCandidates } from '../external-memory-import-adapters';
import { sanitizeCliCommandEvent } from '../context-safety';

function explicitMemoryPayload(summary: string) {
  const occurredAt = '2026-07-14T12:00:00.000Z';
  const idempotencyKey = deriveContextEventIdempotencyKey({
    eventType: 'explicit_memory',
    source_system: 'pi',
    tool_name: 'pi',
    session_id: 'session-1',
    workspace_id: 'rorca',
    occurred_at: occurredAt,
    memory_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  return ContextCaptureEventJobPayload.shape.payload.parse({
    payload_schema_version: '2026-07-ucc-007.v1',
    source_identity: { source_system: 'pi', tool_name: 'pi', host_application: null, session_id: 'session-1', workspace_id: 'rorca', repo_path_hash: null },
    source_system: 'pi',
    tool_name: 'pi',
    host_application: null,
    session_id: 'session-1',
    workspace_id: 'rorca',
    repo_path_hash: null,
    git_branch: null,
    git_sha: null,
    related_files: [{ path: 'backend/src/lib/context-distillation.ts', role: 'mentioned', hash: null }],
    capture_policy: { policy_version: '2026-07-ucc-007', mode: 'full', raw_content: 'explicit' },
    trust_tier: 'local',
    idempotency_key: idempotencyKey,
    provenance: { capture_source: 'mcpSlashCommand', source_event_id: 'event-1', adapter_version: null, emitted_at: occurredAt, received_at: occurredAt, local_only: true },
    eventType: 'explicit_memory',
    memory_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    memory_summary: summary,
    category: 'Decision',
    requested_by: 'human',
  });
}

describe('Always-On Context mainline reconciliation', () => {
  test('metadata-only capture omits command text while retaining a stable command hash', () => {
    const first = sanitizeCliCommandEvent({
      eventType: 'shell_command',
      command: 'deploy --token super-secret-value',
      policyMode: 'metadata-only',
      source_system: 'shell',
      tool_name: 'shell',
      session_id: 's1',
    });
    const second = sanitizeCliCommandEvent({
      eventType: 'shell_command',
      command: 'deploy --token super-secret-value',
      policyMode: 'metadata-only',
      source_system: 'shell',
      tool_name: 'shell',
      session_id: 's1',
    });

    expect(first.payload?.command_summary).toBeNull();
    expect(first.payload?.command_hash).toBe(second.payload?.command_hash);
    expect(JSON.stringify(first.payload)).not.toContain('super-secret-value');
  });

  test('non-full policies reject transcript capture at the canonical safety boundary', () => {
    expect(() => sanitizeCliCommandEvent({ command: 'echo ok', transcript: 'raw output', policyMode: 'repo-and-command' }))
      .toThrow('Transcript capture requires full explicit-session summary policy');
  });

  test('distillation maps source vocabularies onto canonical mainline event/trust values', () => {
    expect(__contextDistillationInternals.canonicalEventType('agent_cli_session')).toBe('manual_note');
    expect(__contextDistillationInternals.canonicalEventType('ci_pr')).toBe('pr_merge');
    expect(__contextDistillationInternals.canonicalTrustTier('local')).toBe('working_note');
    expect(__contextDistillationInternals.canonicalTrustTier('privileged')).toBe('approved_policy');
  });

  test('explicit durable context becomes a reviewable canonical candidate draft', () => {
    const payload = explicitMemoryPayload('Always create pg-boss queues before sending jobs.');
    const candidate = distillContextEventToCandidate({
      eventId: 42,
      occurredAt: '2026-07-14T12:00:00.000Z',
      payload,
      safetyContentHash: 'capture-hash',
    });

    expect(candidate).toMatchObject({
      workspaceId: 'rorca',
      category: 'Architecture',
      confidence: 'high',
      relatedFiles: ['backend/src/lib/context-distillation.ts'],
    });
    expect(candidate?.dedupeKey).toMatch(/^sha256:/);
  });

  test('external import identity is stable across import time but changes with content', async () => {
    const base = {
      workspaceId: 'rorca',
      vendor: 'memory-bank' as const,
      dryRun: true,
      source: { rawText: JSON.stringify([{ id: 'rule-1', content: 'Always preserve API-only capture.' }]), format: 'json' as const },
    };
    const first = await importExternalMemoryCandidates({ ...base, importedAt: '2026-07-14T10:00:00Z' });
    const second = await importExternalMemoryCandidates({ ...base, importedAt: '2026-07-14T11:00:00Z' });
    const changed = await importExternalMemoryCandidates({
      ...base,
      importedAt: '2026-07-14T12:00:00Z',
      source: { rawText: JSON.stringify([{ id: 'rule-1', content: 'Always preserve API-only capture and review.' }]), format: 'json' as const },
    });

    expect(first.candidates[0].dedupeKey).toBe(second.candidates[0].dedupeKey);
    expect(changed.candidates[0].dedupeKey).not.toBe(first.candidates[0].dedupeKey);
  });

  test('reconciliation migration is additive and never manages pgboss schema', () => {
    const migration = fs.readFileSync(path.resolve(__dirname, '../../db/pg-migrations/20260715130000_always_on_context_mainline_reconciliation.sql'), 'utf8');
    expect(migration).not.toMatch(/(?:CREATE|ALTER|DROP|DELETE\s+FROM)\s+(?:TABLE\s+)?pgboss\./i);
    expect(migration).not.toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(?:status|category|content|payload)\b/i);
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS distillation_status');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS context_capture_settings');
  });

  test('operator routes carry explicit tiers/rationales and do not claim public stability', () => {
    const route = fs.readFileSync(path.resolve(__dirname, '../../routes/context-capture.ts'), 'utf8');
    const operations = route.split(/\n\s*\/\*\*\n/).filter((block) => block.includes('@swagger'));
    for (const operation of operations) {
      expect(operation).toMatch(/x-rorca-tier:\s+(?:auth|admin)/);
      expect(operation).toMatch(/x-rorca-rationale:/);
      expect(operation).not.toContain('x-rorca-public-api: true');
    }
  });

  test('pg-boss queues are created explicitly and uninstall cancels through the pg-boss API', () => {
    const boss = fs.readFileSync(path.resolve(__dirname, '../pg-boss.ts'), 'utf8');
    const route = fs.readFileSync(path.resolve(__dirname, '../../routes/context-capture.ts'), 'utf8');
    expect(boss).toContain("await boss.createQueue('context:capture')");
    expect(boss).toContain("await boss.createQueue('context:distill')");
    expect(boss).not.toContain("createQueue('capture:ingest')");
    expect(route).toContain("await boss.createQueue('context:capture')");
    expect(route).toContain("await boss.cancel('context:capture', job.id)");
    expect(route).not.toMatch(/DELETE\s+FROM\s+pgboss\./i);
  });

  test('mainline keeps CCS public ingestion/governance routes mounted beside operator controls', () => {
    const server = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');
    expect(server).toContain("app.use('/api/context-events', contextEventsRouter)");
    expect(server).toContain("app.use('/api/context-candidates', contextCandidatesRouter)");
    expect(server).toContain("app.use('/api/memory/candidates', memoryCandidatesRouter)");
    expect(server).toContain("app.use('/api/context-capture', contextCaptureRouter)");
  });
});
