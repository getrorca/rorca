/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySandboxInfrastructureFailure } from '../sandbox-infrastructure-failure';

test('Seatbelt and native-PTY failures are terminal infrastructure blockers', () => {
  for (const output of [
    'sandbox-exec: sandbox violation: deny file-read-data',
    "Error: Cannot find module '../build/Release/pty.node'",
    'Error: Module did not self-register: node-pty',
  ]) {
    assert.deepEqual(classifySandboxInfrastructureFailure(output), {
      category: 'sandbox_infrastructure_failure',
      message: output,
      retryable: false,
    });
  }
});

test('provider output does not become an infrastructure blocker', () => {
  assert.equal(classifySandboxInfrastructureFailure('provider returned a rate limit response'), null);
});
