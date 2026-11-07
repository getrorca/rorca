/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTY_SECRET_REDACTION_MARKER,
  PtyOutputPersistenceRedactor,
  redactPtyOutputForPersistence,
} from '../pty-output-redaction';

test('redacts terminal credentials before durable PTY persistence', () => {
  const token = `ghp_${'A'.repeat(32)}`;
  const output = Buffer.from(`\u001b[32momp ready\u001b[0m\nGITHUB_TOKEN=${token}\n`, 'utf8');

  const redacted = redactPtyOutputForPersistence(output).toString('utf8');

  assert.match(redacted, /omp ready/);
  assert.equal(redacted.includes(PTY_SECRET_REDACTION_MARKER), true);
  assert.equal(redacted.includes(token), false);
});

test('redacts credentials split across PTY callbacks before releasing a record', () => {
  const scrubber = new PtyOutputPersistenceRedactor();
  assert.deepEqual(scrubber.accept(Buffer.from('OPENAI_API_KEY=sk-ant-partial')), []);
  const released = scrubber.accept(Buffer.from('-credential-value-123456789\r\n'));
  const text = Buffer.concat(released).toString('utf8');
  assert.equal(text.includes('sk-ant-partial-credential-value-123456789'), false);
  assert.equal(text.includes(PTY_SECRET_REDACTION_MARKER), true);
});

test('preserves ordinary ANSI terminal bytes exactly', () => {
  const output = Buffer.from('\u001b[36momp session attached\u001b[0m\r\n', 'utf8');
  assert.deepEqual(redactPtyOutputForPersistence(output), output);
});
