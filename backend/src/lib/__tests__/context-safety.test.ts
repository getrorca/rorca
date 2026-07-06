/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { formatRedactionDiagnostics, sanitizeCapturePayload, sanitizeCliCommandEvent } from '../context-safety';

describe('context-safety privacy diagnostics', () => {
  test('redaction diagnostics expose counts and types but not sentinel secret values', () => {
    const sentinel = 'sk-test-1234567890abcdefghijklmnopqrstuvwxyz';
    const sanitized = sanitizeCliCommandEvent({
      policyMode: 'repo-and-command',
      command: `curl -H "Authorization: Bearer ${sentinel}" https://example.test --data password=${sentinel}`,
      cwd: '/repo',
      workspacePath: '/repo',
      eventType: 'shell_command',
    });

    const serialized = JSON.stringify({ payload: sanitized.payload, safety: sanitized.safety, diagnostics: formatRedactionDiagnostics(sanitized.safety) });
    expect(serialized).not.toContain(sentinel);
    expect(sanitized.safety.redactionCount).toBeGreaterThan(0);
    expect(formatRedactionDiagnostics(sanitized.safety).redactionTypes.length).toBeGreaterThan(0);
  });

  test('raw payload fields are hashed instead of stored in audit-safe summaries', () => {
    const sentinel = 'SUPER_SECRET_VALUE_12345678901234567890';
    const sanitized = sanitizeCapturePayload({ eventType: 'editor_activity', content: sentinel, token: sentinel });
    const diagnostics = formatRedactionDiagnostics(sanitized.safety);
    const serialized = JSON.stringify({ payload: sanitized.payload, diagnostics });

    expect(serialized).not.toContain(sentinel);
    expect(diagnostics.redactionCount).toBeGreaterThan(0);
    expect(diagnostics.redactionTypes).toContain('raw_content');
  });
});
