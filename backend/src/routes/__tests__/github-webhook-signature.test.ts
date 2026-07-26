/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { verifyWebhookSignature } from '../workspace-github';

const secret = 'a-vaulted-webhook-secret';
const body = Buffer.from('{"installation":{"id":77},"repository":{"id":99}}');

function signature(value: Buffer): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(value).digest('hex')}`;
}

test('accepts exact raw bytes and rejects tampering, malformed signatures, and wrong secrets', () => {
  expect(verifyWebhookSignature(body, signature(body), secret)).toBe(true);
  expect(verifyWebhookSignature(Buffer.from(`${body.toString()} `), signature(body), secret)).toBe(false);
  expect(verifyWebhookSignature(body, 'sha1=abc', secret)).toBe(false);
  expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
  expect(verifyWebhookSignature(body, signature(body), 'wrong-secret')).toBe(false);
});
