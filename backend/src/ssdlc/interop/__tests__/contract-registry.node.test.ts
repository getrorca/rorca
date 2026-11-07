/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ContractRegistryError, resolveContract, SSDLC_CONTRACT_REGISTRY, verifyContractRegistry,
  type ContractRegistration,
} from '../contract-registry';

function copy(entry: ContractRegistration): ContractRegistration {
  return { ...entry, provider: { ...entry.provider }, consumers: entry.consumers.map((consumer) => ({ ...consumer })) };
}

async function rejectsWithCode(promise: Promise<unknown>, code: ContractRegistryError['code']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof ContractRegistryError && error.code === code);
}

describe('SSDLC consumer-driven contract registry', () => {
  test('loads provider artifacts, executes every consumer fixture, and emits a stable machine receipt', async () => {
    const receipt = await verifyContractRegistry();
    assert.equal(receipt.schemaVersion, 'rorca.ssdlc-contract-registry-receipt.v1');
    assert.equal(receipt.contractCount, SSDLC_CONTRACT_REGISTRY.length);
    assert.equal(receipt.assertionCount, SSDLC_CONTRACT_REGISTRY.reduce((count, entry) => count + entry.consumers.length, 0));
    assert.match(receipt.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(new Set(receipt.contracts.map(({ contract, version }) => `${contract}@${version}`)).size, receipt.contractCount);
    for (const contract of receipt.contracts) {
      assert.ok(contract.provider);
      assert.ok(contract.artifactPath.startsWith('backend/src/'));
      assert.ok(contract.consumers.length > 0);
    }
    assert.deepEqual(await verifyContractRegistry(), receipt);
  });

  test('fails closed on a malformed provider shape', async () => {
    const malformed = SSDLC_CONTRACT_REGISTRY.map(copy);
    malformed[0] = { ...malformed[0], consumers: [{ ...malformed[0].consumers[0], fixture: { schemaVersion: 'rorca.source-bundle.v1' } }] };
    await rejectsWithCode(verifyContractRegistry(malformed), 'CONSUMER_ASSERTION_FAILED');
  });

  test('rejects an unknown version', () => {
    assert.throws(
      () => resolveContract('LifecycleEvidence', 'rorca.lifecycle-evidence.v2'),
      (error: unknown) => error instanceof ContractRegistryError && error.code === 'UNKNOWN_VERSION',
    );
  });

  test('rejects duplicate ownership', async () => {
    const duplicate = [...SSDLC_CONTRACT_REGISTRY.map(copy), copy(SSDLC_CONTRACT_REGISTRY[0])];
    await rejectsWithCode(verifyContractRegistry(duplicate), 'DUPLICATE_OWNER');
  });

  test('rejects a missing consumer assertion', async () => {
    const missing = SSDLC_CONTRACT_REGISTRY.map(copy);
    missing[0] = { ...missing[0], consumers: [{ ...missing[0].consumers[0], assert: undefined as never }] };
    await rejectsWithCode(verifyContractRegistry(missing), 'MISSING_CONSUMER_ASSERTION');
  });

  test('binds AAV and gate consumers to canonical controls and lifecycle evidence providers', () => {
    const catalog = resolveContract('controls.json', '1');
    assert.equal(catalog.provider.owner, 'US-008');
    assert.ok(catalog.consumers.some(({ consumer }) => consumer === 'AAV control lookup'));

    const lifecycle = resolveContract('LifecycleEvidence', 'rorca.lifecycle-evidence.v1');
    assert.deepEqual(lifecycle.consumers.map(({ consumer }) => consumer), [
      'AAV assurance kernel/evidence adapter', 'US-005 evaluator',
    ]);
    const hermes = resolveContract('HermesEvidence', 'hermes.evidence.v1');
    assert.ok(hermes.consumers.some(({ consumer }) => consumer === 'US-005 evaluator'));
  });
});
