/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

describe('Hermes cross-service version handshake', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../routes/version.ts'), 'utf8');

  test('advertises exact fail-closed API and governed endpoint contracts', () => {
    for (const expected of [
      "const API_VERSION = '1.0'",
      "contractVersion: 'v1'",
      "endpoint: '/api/pipeline/telemetry'",
      "endpoint: '/api/admin/recovery/checkpoints/reconcile'",
      "endpoint: '/api/pipeline/task-manifests/trigger'",
      "endpoint: '/api/pipeline/runs/{runId}/retry'",
      "contextEndpoint: '/api/specs/generation-context'",
      "preflightEndpoint: '/api/specs/authoring/preflight'",
      "persistEndpoint: '/api/specs/persist'",
      "approveEndpoint: '/api/specs/{specId}/approve'",
      "compileEndpoint: '/api/specs/{specId}/lifecycle/compile'",
      "evidenceEndpoint: '/api/lifecycle/evidence'",
      "contractVersion: 'v2'",
      "operatorAttachmentOnly: true",
    ]) {
      expect(source).toContain(expected);
    }
  });
});
