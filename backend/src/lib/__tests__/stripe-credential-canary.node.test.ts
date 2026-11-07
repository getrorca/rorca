/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  StripeTestModeCredentialCanaryAdapter,
  type StripeCredentialOperationInput,
  type StripeCredentialSecretExecutor,
  type StripeHttpOperationResult,
  type StripeHttpTransport,
} from '../stripe-credential-canary';

const CREDENTIAL = Buffer.from('rk_test_secretMaterialForCanary123', 'ascii');
const INPUT: StripeCredentialOperationInput = {
  workspaceId: 'workspace-stripe-canary',
  accountId: 'acct_rorca_canary',
  mode: 'test',
  secretStoreReference: 'secret-store://rorca/provider-credentials/70000000-0000-4000-8000-000000000001',
  expectedFingerprint: `sha256:${'a'.repeat(64)}`,
  permissionManifest: ['payment_intents.read'],
  canary: {
    operation: 'payment_intents.read',
    resourceType: 'payment_intents',
    resourceId: 'pi_disposable_canary',
    timeoutMs: 10_000,
  },
};

class MemorySecretExecutor implements StripeCredentialSecretExecutor {
  calls = 0;

  async useCredential<T>(input: {
    secretStoreReference: string;
    expectedFingerprint: string;
    operation: (credential: Uint8Array) => Promise<T>;
  }): Promise<T> {
    this.calls += 1;
    assert.equal(input.secretStoreReference, INPUT.secretStoreReference);
    assert.equal(input.expectedFingerprint, INPUT.expectedFingerprint);
    return input.operation(CREDENTIAL);
  }
}

class RecordingTransport implements StripeHttpTransport {
  calls: Array<{ path: string; timeoutMs: number; credential: string }> = [];

  constructor(private result: StripeHttpOperationResult) {}

  setResult(result: StripeHttpOperationResult): void {
    this.result = result;
  }

  async request(input: {
    path: string;
    credential: Uint8Array;
    timeoutMs: number;
  }): Promise<StripeHttpOperationResult> {
    this.calls.push({
      path: input.path,
      timeoutMs: input.timeoutMs,
      credential: Buffer.from(input.credential).toString('ascii'),
    });
    return this.result;
  }
}

describe('Stripe test-mode credential canary', () => {
  it('calls the declared real Stripe resource operation and returns only bounded receipt evidence', async () => {
    const secrets = new MemorySecretExecutor();
    const transport = new RecordingTransport({
      statusCode: 200,
      providerRequestReference: 'req_canary_001',
      body: { id: INPUT.canary.resourceId, object: 'payment_intent', livemode: false },
    });
    const adapter = new StripeTestModeCredentialCanaryAdapter(secrets, transport);

    const receipt = await adapter.runCanary(INPUT, new Date('2026-08-24T10:00:00.000Z'));

    assert.equal(secrets.calls, 1);
    assert.deepEqual(transport.calls, [{
      path: '/v1/payment_intents/pi_disposable_canary',
      timeoutMs: 10_000,
      credential: CREDENTIAL.toString('ascii'),
    }]);
    assert.equal(receipt.operation, 'payment_intents.read');
    assert.equal(receipt.providerRequestReference, 'req_canary_001');
    assert.equal(JSON.stringify(receipt).includes(CREDENTIAL.toString('ascii')), false);
    assert.doesNotMatch(transport.calls[0]!.path, /health/i);
  });

  it('timestamps a successful canary only after the provider operation settles', async () => {
    let providerSettled = false;
    const transport: StripeHttpTransport = {
      async request(): Promise<StripeHttpOperationResult> {
        providerSettled = true;
        return {
          statusCode: 200,
          providerRequestReference: 'req_canary_completed',
          body: { id: INPUT.canary.resourceId, livemode: false },
        };
      },
    };
    const adapter = new StripeTestModeCredentialCanaryAdapter(
      new MemorySecretExecutor(),
      transport,
      () => {
        assert.equal(providerSettled, true);
        return new Date('2026-08-24T10:00:05.000Z');
      },
    );

    const receipt = await adapter.runCanary(INPUT);

    assert.equal(receipt.verifiedAt, '2026-08-24T10:00:05.000Z');
  });

  it('rejects local-health, unsupported, write, and live-mode substitutions before transport', async () => {
    const transport = new RecordingTransport({
      statusCode: 200,
      providerRequestReference: 'req_unused',
      body: {},
    });
    const adapter = new StripeTestModeCredentialCanaryAdapter(new MemorySecretExecutor(), transport);

    await assert.rejects(
      adapter.runCanary({
        ...INPUT,
        canary: { ...INPUT.canary, operation: 'health.read', resourceType: 'health' },
      }),
    );
    await assert.rejects(
      adapter.runCanary({
        ...INPUT,
        permissionManifest: ['payment_intents.write'],
        canary: { ...INPUT.canary, operation: 'payment_intents.write' },
      }),
    );
    await assert.rejects(adapter.runCanary({ ...INPUT, mode: 'live' } as unknown as StripeCredentialOperationInput));
    assert.equal(transport.calls.length, 0);
  });

  it('accepts only a real 401 response as old-key rejection proof', async () => {
    const transport = new RecordingTransport({
      statusCode: 200,
      providerRequestReference: 'req_old_still_active',
      body: { id: INPUT.canary.resourceId, livemode: false },
    });
    const adapter = new StripeTestModeCredentialCanaryAdapter(new MemorySecretExecutor(), transport);

    await assert.rejects(
      adapter.verifyRejected(INPUT),
      /old credential has not been verified as rejected/,
    );

    transport.setResult({
      statusCode: 401,
      providerRequestReference: 'req_old_rejected',
      body: { error: { type: 'invalid_request_error' } },
    });
    const receipt = await adapter.verifyRejected(INPUT, new Date('2026-08-24T10:05:00.000Z'));
    assert.equal(receipt.result, 'authentication_rejected');
    assert.equal(receipt.providerRequestReference, 'req_old_rejected');
    assert.equal(JSON.stringify(receipt).includes(CREDENTIAL.toString('ascii')), false);
  });

  it('reads active, rejected, and indeterminate provider status without exposing the credential', async () => {
    const transport = new RecordingTransport({
      statusCode: 200,
      providerRequestReference: 'req_status_active',
      body: { id: INPUT.canary.resourceId, livemode: false },
    });
    const adapter = new StripeTestModeCredentialCanaryAdapter(new MemorySecretExecutor(), transport);

    const active = await adapter.readStatus(INPUT, new Date('2026-08-24T10:06:00.000Z'));
    assert.equal(active.status, 'active');
    assert.equal(active.evidenceCode, 'provider_operation_succeeded');

    transport.setResult({
      statusCode: 401,
      providerRequestReference: 'req_status_rejected',
      body: {},
    });
    const rejected = await adapter.readStatus(INPUT, new Date('2026-08-24T10:07:00.000Z'));
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.evidenceCode, 'provider_authentication_rejected');

    transport.setResult({
      statusCode: 503,
      providerRequestReference: 'req_status_unknown',
      body: {},
    });
    const unknown = await adapter.readStatus(INPUT, new Date('2026-08-24T10:08:00.000Z'));
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.evidenceCode, 'provider_response_indeterminate');
    assert.doesNotMatch(
      JSON.stringify([active, rejected, unknown]),
      /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/,
    );
  });

  it('converts transport uncertainty into a fixed secret-free unknown-status receipt', async () => {
    const credential = CREDENTIAL.toString('ascii');
    const transport: StripeHttpTransport = {
      async request(): Promise<StripeHttpOperationResult> {
        throw new Error(`Transport failed while using ${credential}`);
      },
    };
    const adapter = new StripeTestModeCredentialCanaryAdapter(new MemorySecretExecutor(), transport);

    const receipt = await adapter.readStatus(INPUT, new Date('2026-08-24T10:09:00.000Z'));

    assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.evidenceCode, 'provider_readback_unavailable');
    assert.equal(receipt.providerRequestReference, null);
    assert.equal(JSON.stringify(receipt).includes(credential), false);
  });
});
