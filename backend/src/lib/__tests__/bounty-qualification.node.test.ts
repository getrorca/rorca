/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  BOUNTY_QUALIFICATION_STATUS,
  BOUNTY_RECEIPT_BINDING_KEYS,
  verifyBountyQualificationReceipt,
  type BountyQualificationReceipt,
} from '../bounty-qualification';

const root = process.cwd().endsWith('/backend') ? resolve(process.cwd(), '..') : process.cwd();
const receipt = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/bounty-qualification/qualification-receipt.v1.json'), 'utf8')) as BountyQualificationReceipt;

test('bounty-immutable-receipt.contract verifies a complete disabled hermetic fixture receipt', () => {
  const verified = verifyBountyQualificationReceipt(receipt);
  assert.equal(verified.release.featureState, 'disabled');
  assert.equal(verified.release.enableAvailable, false);
  assert.equal(BOUNTY_QUALIFICATION_STATUS.state, 'requalification-required');
  assert.equal(BOUNTY_QUALIFICATION_STATUS.releaseEnableAvailable, false);
});

test('every prompt, skill, router, oracle, persona, model, runtime and policy identity is requalification-bound', () => {
  for (const key of BOUNTY_RECEIPT_BINDING_KEYS) {
    const changed = key === 'sourceSha' ? 'f'.repeat(40) : `sha256:${'f'.repeat(64)}`;
    assert.throws(
      () => verifyBountyQualificationReceipt(receipt, { ...receipt.bindings, [key]: changed }),
      new RegExp(`${key} changed`),
      key,
    );
  }
});

test('receipt, evidence, metrics and corpus tampering fail closed', () => {
  const mutations: BountyQualificationReceipt[] = [
    { ...receipt, receiptHash: `sha256:${'0'.repeat(64)}` },
    { ...receipt, metrics: { ...receipt.metrics, oracleFailures: 1 } },
    { ...receipt, suiteEvidence: receipt.suiteEvidence.slice(1) },
    { ...receipt, corpora: receipt.corpora.map((item, index) => index ? item : { ...item, repositoryContentIncluded: true as false }) },
    { ...receipt, release: { ...receipt.release, enableAvailable: true as false } },
  ];
  for (const mutation of mutations) assert.throws(() => verifyBountyQualificationReceipt(mutation));
});
