/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../../lib/errors';
import { ContextCaptureEventJobPayload } from '../../lib/pg-boss-schemas';
import { normalizeContextEventPayload } from '../context-capture';

const baseInput = {
  workspaceId: 'rorca',
  workspacePath: '/tmp/rorca',
  source: 'shellIntegration' as const,
  occurredAt: '2026-07-05T00:00:00.000Z',
  policyMode: 'repo-and-command' as const,
  policyVersion: '2026-07-ucc-007',
};

describe('context-capture route validation helpers', () => {
  test('normalizes cli command identity into UCC-007 source/provenance shape', () => {
    const payload = normalizeContextEventPayload({
      ...baseInput,
      payload: {
        eventType: 'cli_command',
        source_system: 'shell',
        tool_name: 'shell',
        session_id: 'session-1',
        commandSummary: 'npm test',
        commandHash: 'a'.repeat(64),
        phase: 'end',
        exitCode: 0,
        durationMs: 50,
        gitBranch: 'main',
        gitSha: 'b'.repeat(40),
        agent: { recognized: false, binary: 'unknown' },
        regulatedSignals: [],
      },
    });

    expect(payload.eventType).toBe('shell_command');
    expect(payload.payload_schema_version).toBe('2026-07-ucc-007.v1');
    expect(payload.source_identity).toMatchObject({ source_system: 'shell', tool_name: 'shell', session_id: 'session-1', workspace_id: 'rorca' });
    expect(payload.idempotency_key).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(payload.provenance.capture_source).toBe('shellIntegration');
    expect(payload.trust_tier).toBe('local');
  });

  test('accepts canonical safety diagnostics from daemon and shell clients', () => {
    const payload = normalizeContextEventPayload({
      ...baseInput,
      source: 'repoDaemon',
      payload: {
        eventType: 'git_commit',
        source_system: 'daemon',
        tool_name: 'rorca-capture-daemon',
        git_sha: 'c'.repeat(40),
      },
    });

    expect(ContextCaptureEventJobPayload.safeParse({
      workspaceId: 'rorca',
      source: 'repoDaemon',
      occurredAt: baseInput.occurredAt,
      payload,
      safety: {
        contextSafetyModule: 'backend/src/lib/context-safety.ts',
        policyVersion: '2026-07-ucc-007',
        redactionCount: 1,
        ignoredPathCount: 0,
        truncated: false,
        hashAlgorithm: 'sha256',
        contentHash: 'a'.repeat(64),
        redactionTypes: ['api_key'],
        regulatedSignals: ['possible_credit_card'],
      },
    }).success).toBe(true);
  });

  test('preserves agent adapter source metadata for remember events', () => {
    const payload = normalizeContextEventPayload({
      ...baseInput,
      source: 'mcpSlashCommand',
      payload: {
        eventType: 'agent_memory',
        source_system: 'claude_code',
        tool_name: 'claude-code',
        session_id: 'claude-session-1',
        summary: 'Prefer token file paths over embedded bearer values.',
        category: 'Decision',
      },
    });

    expect(payload.eventType).toBe('explicit_memory');
    if (payload.eventType !== 'explicit_memory') throw new Error('expected explicit memory payload');
    expect(payload.source_system).toBe('claude_code');
    expect(payload.source_identity).toMatchObject({ source_system: 'claude_code', tool_name: 'claude-code', session_id: 'claude-session-1' });
    expect(payload.memory_summary).toBe('Prefer token file paths over embedded bearer values.');
    expect(payload.requested_by).toBe('agent');
    expect(payload.idempotency_key).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('preserves all first-class adapter source_system values', () => {
    for (const sourceSystem of ['pi', 'claude_code', 'codex', 'opencode', 'shell', 'ide', 'daemon'] as const) {
      const payload = normalizeContextEventPayload({
        ...baseInput,
        source: sourceSystem === 'shell' ? 'shellIntegration' : sourceSystem === 'ide' ? 'vscodeExtension' : sourceSystem === 'daemon' ? 'repoDaemon' : 'agentAdapter',
        payload: {
          eventType: 'adapter_context',
          source_system: sourceSystem,
          tool_name: `${sourceSystem}-tool`,
          session_id: `${sourceSystem}-session`,
          summary: `${sourceSystem} adapter decision`,
        },
      });

      expect(payload.source_system).toBe(sourceSystem);
      expect(payload.tool_name).toBe(`${sourceSystem}-tool`);
      expect(payload.session_id).toBe(`${sourceSystem}-session`);
    }
  });

  test('normalizes legacy cli_command input to canonical shell_command', () => {
    const payload = normalizeContextEventPayload({
      ...baseInput,
      payload: {
        eventType: 'cli_command',
        command: 'echo hello',
        session_id: 'legacy-session',
      },
    });

    expect(payload.eventType).toBe('shell_command');
    expect(payload.source_system).toBe('shell');
    expect(payload.source_identity.session_id).toBe('legacy-session');
  });

  test('rejects malformed event types through ValidationError', () => {
    expect(() => normalizeContextEventPayload({ ...baseInput, payload: { eventType: 'bad_event' } })).toThrow(ValidationError);
  });

  test('keeps admin Swagger tier annotations and request contract shape', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'context-capture.ts'), 'utf8');
    const eventsDoc = source.slice(source.indexOf('/api/context-capture/events'), source.indexOf("router.post('/events'"));
    expect(eventsDoc).toContain('x-rorca-tier: admin');
    expect(eventsDoc).toContain('x-rorca-rationale:');
    expect(eventsDoc).not.toContain('x-rorca-public-api: true');
    expect(eventsDoc).toContain('payload: { type: object }');
  });

  test('events route uses pg-boss context:capture queue instead of direct context table writes', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'context-capture.ts'), 'utf8');
    const handler = source.slice(source.indexOf("router.post('/events'"), source.indexOf('/api/context-capture/capability'));
    expect(handler).toContain("boss.createQueue('context:capture')");
    expect(handler).toContain("boss.send('context:capture'");
    expect(handler).toContain("recordContextCaptureSubmission");
    expect(handler).not.toMatch(/INSERT\s+INTO\s+context_events/i);
  });

  test('monitoring route is admin-only and covers production capture signals', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'context-capture.ts'), 'utf8');
    const monitoring = source.slice(source.indexOf('/api/context-capture/{workspaceId}/monitoring'), source.indexOf("router.get('/:workspaceId/stream'"));
    expect(monitoring).toContain('x-rorca-tier: admin');
    expect(monitoring).toContain('getContextCaptureMonitoring');
    expect(monitoring).toContain('readCaptureDaemonMonitoring');
    expect(monitoring).toContain('monitoring.distillation.activeErrors > 0');
    expect(monitoring).toContain('distillation_events_error');
    expect(monitoring).toContain('distillation_historical_errors_accepted');
    expect(monitoring).toContain("backend: { status: 'ok'");
  });

  test('candidate compatibility migration and inserts satisfy canonical brownfield required fields', () => {
    const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'pg-migrations', '20260714143000_context_capture_candidate_compatibility.sql'), 'utf8');
    const distillation = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'context-distillation.ts'), 'utf8');
    const imports = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'external-memory-import-adapters.ts'), 'utf8');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS payload JSONB');
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS rule TEXT NOT NULL DEFAULT ''");
    expect(distillation).toMatch(/payload, title, rule, status, category/);
    expect(imports).toMatch(/payload, title, rule, status, category/);
  });

  test('bootstrap verification locks queue, redaction, and ignore paths to canonical locations', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'context-capture.ts'), 'utf8');
    const verifyHandler = source.slice(source.indexOf('/api/context-capture/bootstrap/verify'), source.indexOf("router.post('/events'"));
    expect(verifyHandler).toContain("assertExpectedBootstrapPath(registeredPath, queuePath, 'queuePath', '.rorca-capture-queue.jsonl')");
    expect(verifyHandler).toContain("assertExpectedBootstrapPath(registeredPath, redactionConfigPath, 'redactionConfigPath', path.join('.rorca', 'capture', 'redaction.json'))");
    expect(verifyHandler).toContain("assertExpectedBootstrapPath(registeredPath, captureIgnorePath, 'captureIgnorePath', '.rorca-captureignore')");
  });
});
