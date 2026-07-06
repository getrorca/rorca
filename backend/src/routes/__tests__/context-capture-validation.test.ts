/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../../lib/errors';
import { normalizeContextEventPayload } from '../context-capture';

const baseInput = {
  workspaceId: 'rorca',
  workspacePath: '/tmp/rorca',
  source: 'shellIntegration' as const,
  occurredAt: '2026-07-05T00:00:00.000Z',
  policyMode: 'command-summary' as const,
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

    expect(payload.eventType).toBe('cli_command');
    expect(payload.payload_schema_version).toBe('2026-07-ucc-007.v1');
    expect(payload.source_identity).toMatchObject({ source_system: 'shell', tool_name: 'shell', session_id: 'session-1', workspace_id: 'rorca' });
    expect(payload.idempotency_key).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(payload.provenance.capture_source).toBe('shellIntegration');
    expect(payload.trust_tier).toBe('local');
  });

  test('rejects malformed event types through ValidationError', () => {
    expect(() => normalizeContextEventPayload({ ...baseInput, payload: { eventType: 'bad_event' } })).toThrow(ValidationError);
  });

  test('keeps public Swagger tier annotations and request contract shape', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'context-capture.ts'), 'utf8');
    const eventsDoc = source.slice(source.indexOf('/api/context-capture/events'), source.indexOf("router.post('/events'"));
    expect(eventsDoc).toContain('x-rorca-tier: public');
    expect(eventsDoc).toContain('x-rorca-rationale:');
    expect(eventsDoc).toContain('x-rorca-public-api: true');
    expect(eventsDoc).toContain('payload: { type: object }');
  });

  test('events route uses pg-boss context:capture queue instead of direct context table writes', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'context-capture.ts'), 'utf8');
    const handler = source.slice(source.indexOf("router.post('/events'"), source.indexOf('/api/context-capture/capability'));
    expect(handler).toContain("boss.createQueue('context:capture')");
    expect(handler).toContain("boss.send('context:capture'");
    expect(handler).not.toMatch(/INSERT\s+INTO\s+context/i);
  });

  test('bootstrap verification locks queue, redaction, and ignore paths to canonical locations', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'context-capture.ts'), 'utf8');
    const verifyHandler = source.slice(source.indexOf('/api/context-capture/bootstrap/verify'), source.indexOf("router.post('/events'"));
    expect(verifyHandler).toContain("assertExpectedBootstrapPath(registeredPath, queuePath, 'queuePath', path.join('.rorca', 'capture', 'queue'))");
    expect(verifyHandler).toContain("assertExpectedBootstrapPath(registeredPath, redactionConfigPath, 'redactionConfigPath', path.join('.rorca', 'capture', 'redaction.json'))");
    expect(verifyHandler).toContain("assertExpectedBootstrapPath(registeredPath, captureIgnorePath, 'captureIgnorePath', '.rorca-captureignore')");
  });
});
