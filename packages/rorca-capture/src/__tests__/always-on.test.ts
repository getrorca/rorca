/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildShellCaptureEnvelope,
  renderCaptureService,
  setupAlwaysOnCapture,
  type CapturePolicyMode,
} from '../always-on.js';

function workspace(root: string) {
  return { id: 'test-workspace', path: root, resolvedBy: 'config' as const };
}

describe('always-on capture sidecar integration', () => {
  test('dry-run setup is reversible and performs no filesystem writes', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rorca-capture-setup-'));
    mkdirSync(path.join(root, '.git'));
    const result = setupAlwaysOnCapture({
      workspace: workspace(root),
      apiUrl: 'http://127.0.0.1:3030',
      policyMode: 'metadata-only',
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.installed.length).toBeGreaterThan(5);
    expect(existsSync(path.join(root, '.rorca', 'capture'))).toBe(false);
  });

  test.each(['metadata-only', 'repo-and-command'] satisfies CapturePolicyMode[])(
    '%s shell events retain identity without raw output',
    (policyMode: CapturePolicyMode) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'rorca-capture-event-'));
      const envelope = buildShellCaptureEnvelope({
        workspace: workspace(root),
        command: 'deploy --token super-secret-value',
        phase: 'end',
        policyMode,
        exitCode: 0,
        occurredAt: '2026-07-14T12:00:00.000Z',
      });
      const payload = envelope?.payload as Record<string, unknown>;

      expect(payload.command_hash).toMatch(/^sha256:/);
      expect(JSON.stringify(envelope)).not.toContain('super-secret-value');
      expect(payload.command_summary).toBe(policyMode === 'metadata-only' ? null : expect.any(String));
      expect(JSON.stringify(envelope)).not.toContain('stdout');
    },
  );

  test('service renderers invoke the canonical package daemon rather than a second daemon', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rorca-capture-service-'));
    const rendered = renderCaptureService('linux', {
      workspace: workspace(root),
      command: '/usr/local/bin/rorca-capture',
      apiUrl: 'http://127.0.0.1:3030',
    });

    expect(rendered.content).toContain('/usr/local/bin/rorca-capture daemon');
    expect(rendered.content).toContain('--workspace');
    expect(rendered.content).not.toContain('DATABASE_URL');
  });
});
