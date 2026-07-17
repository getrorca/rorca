/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { redactMergeDiagnostics } from '../merge-handler';

describe('merge WAL redaction', () => {
  it('removes absolute workspace paths and patch lines from merge evidence', () => {
    const value = redactMergeDiagnostics(
      '--- /private/tmp/work/src/secret.ts\n+++ /private/tmp/work/src/secret.ts\n+token=secret\n@@ -1 +1 @@',
      '/private/tmp/work',
    );
    expect(value).not.toContain('/private/tmp/work');
    expect(value).not.toContain('token=secret');
    expect(value).toContain('[redacted-diff]');
  });
});
