/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createLogger,
  STRIPE_CREDENTIAL_LOG_REDACTION,
} from '../logger';

describe('Stripe credential structured-log boundary', () => {
  it('redacts API keys and webhook signing secrets from messages and nested metadata', () => {
    const apiKey = ['rk', 'test', 'loggerSecretMaterial123'].join('_');
    const webhookSecret = ['whsec', 'loggerSecretMaterial456'].join('_');
    let output = '';
    const destination = {
      write(message: string) {
        output += message;
      },
    };
    const logger = createLogger(destination);

    logger.info({
      credential: apiKey,
      nested: [{ webhookSecret }],
      credentialBytes: Buffer.from(apiKey, 'utf8'),
    }, `Stripe operation rejected ${webhookSecret}`);
    logger.error(new Error(`Stripe credential failed: ${apiKey}`));

    assert.ok(output.includes(STRIPE_CREDENTIAL_LOG_REDACTION));
    assert.ok(!output.includes(apiKey));
    assert.ok(!output.includes(webhookSecret));
    assert.doesNotMatch(
      output,
      /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/,
    );
  });
});
