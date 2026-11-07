/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  KERNEL_VERDICTS,
  createAssuranceKernel,
  type KernelJudgment,
  type KernelSubjectIdentity,
  type KernelVerificationContract,
} from '../assurance-kernel';

const NOW = new Date('2026-03-16T00:06:29.000Z');
const subject: KernelSubjectIdentity = {
  specId: 'source-verified-hermes-rorca-omp-ssdlc-delivery-program',
  specRevision: { kind: 'spec_version', value: 'revision-17' },
  commitSha: '0123456789abcdef0123456789abcdef01234567',
};

function contract(
  judgment: KernelJudgment,
  overrides: Partial<KernelVerificationContract<Record<string, unknown>, unknown>> = {},
): KernelVerificationContract<Record<string, unknown>, unknown> {
  return {
    ...subject,
    controlId: 'CTRL-VERIFICATION-001',
    mechanism: {
      identity: 'mechanism:sha256:9e620da03245f9fd86ea0acdd84cc876510cac945fede34872dbd97f893b44cc',
      async execute() {
        return { subject, outcome: { checks: 3, complete: true } };
      },
    },
    criteria: { judge: () => judgment },
    ...overrides,
  };
}

const kernel = createAssuranceKernel({ now: () => NOW });

describe('tool-agnostic assurance kernel', () => {
  it('executes, judges pass, and binds only the internal exact identity', async () => {
    const result = await kernel.verify(contract({
      verdict: 'pass',
      gap: 'Forward this verified internal outcome to the canonical lifecycle evidence adapter.',
    }), 'hermes:assurance-service');

    assert.deepEqual(KERNEL_VERDICTS, ['pass', 'fail', 'blocked']);
    assert.equal(result.verdict, 'pass');
    assert.equal(result.controlId, 'CTRL-VERIFICATION-001');
    assert.equal(result.specId, subject.specId);
    assert.deepEqual(result.specRevision, subject.specRevision);
    assert.equal(result.commitSha, subject.commitSha);
    assert.equal(result.actor, 'hermes:assurance-service');
    assert.equal(result.verifiedAt, NOW.toISOString());
    assert.equal(result.mechanismIdentity, contract({ verdict: 'pass', gap: 'next' }).mechanism.identity);
    assert.match(result.outcomeDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(result.mechanismOutcome, { checks: 3, complete: true });
    assert.equal('schemaVersion' in result, false);
    assert.equal('gateId' in result, false);
    assert.equal('stage' in result, false);
    assert.equal('gatePassed' in result, false);
  });

  it('preserves a deterministic fail verdict and actionable gap', async () => {
    const result = await kernel.verify(contract({
      verdict: 'fail',
      gap: 'Fix the two unmet criteria and re-run this mechanism.',
    }), 'reviewer:one');

    assert.equal(result.verdict, 'fail');
    assert.equal(result.gap, 'Fix the two unmet criteria and re-run this mechanism.');
  });

  it('preserves a blocked judgment and converts execution failures to blocked', async () => {
    const judged = await kernel.verify(contract({
      verdict: 'blocked',
      gap: 'Grant read access to the required artifact and retry.',
    }), 'reviewer:one');
    assert.equal(judged.verdict, 'blocked');

    const unavailable = contract({ verdict: 'pass', gap: 'unused' }, {
      mechanism: {
        identity: 'mechanism:unavailable:v1',
        async execute() { throw new Error('secret provider text is not copied'); },
      },
    });
    const failed = await kernel.verify(unavailable, 'reviewer:one');
    assert.equal(failed.verdict, 'blocked');
    assert.match(failed.gap, /^Restore the verification mechanism and retry execution/);
    assert.equal(failed.mechanismOutcome, null);
  });

  it('binds the invocation identity even when caller-owned input mutates during execution', async () => {
    const expectedSubject: KernelSubjectIdentity = {
      ...subject,
      specRevision: { ...subject.specRevision },
    };
    const mutable = contract({
      verdict: 'pass',
      gap: 'Forward the identity-bound outcome to the canonical evidence adapter.',
    });
    const expectedControlId = mutable.controlId;
    const expectedMechanismIdentity = mutable.mechanism.identity;
    mutable.mechanism.execute = async () => {
      mutable.controlId = 'CTRL-MUTATED';
      mutable.specRevision = { kind: 'spec_version', value: 'revision-99' };
      mutable.commitSha = 'ffffffffffffffffffffffffffffffffffffffff';
      mutable.mechanism.identity = 'mechanism:mutated';
      return { subject: expectedSubject, outcome: { checks: 3, complete: true } };
    };

    const result = await kernel.verify(mutable, 'reviewer:one');

    assert.equal(result.verdict, 'pass');
    assert.equal(result.controlId, expectedControlId);
    assert.deepEqual(result.specRevision, expectedSubject.specRevision);
    assert.equal(result.commitSha, expectedSubject.commitSha);
    assert.equal(result.mechanismIdentity, expectedMechanismIdentity);
  });

  it('blocks malformed observed identity instead of throwing or judging it', async () => {
    let judgeCalls = 0;
    const malformed = contract({ verdict: 'pass', gap: 'must not be used' }, {
      mechanism: {
        identity: 'mechanism:malformed-observation:v1',
        async execute() {
          return {
            subject: { specId: subject.specId },
            outcome: { checks: 3 },
          } as unknown as Awaited<ReturnType<KernelVerificationContract<Record<string, unknown>>['mechanism']['execute']>>;
        },
      },
      criteria: {
        judge() {
          judgeCalls += 1;
          return { verdict: 'pass', gap: 'must not be used' };
        },
      },
    });

    const result = await kernel.verify(malformed, 'reviewer:one');
    assert.equal(result.verdict, 'blocked');
    assert.match(result.gap, /Re-run the mechanism with a valid observed spec revision and commit identity/);
    assert.equal(judgeCalls, 0);
  });

  it('blocks stale exact identity before criteria can judge it', async () => {
    let judgeCalls = 0;
    const stale = contract({ verdict: 'pass', gap: 'must not be used' }, {
      mechanism: {
        identity: 'mechanism:stale-observation:v1',
        async execute() {
          return {
            subject: {
              ...subject,
              specRevision: { kind: 'spec_version', value: 'revision-16' },
              commitSha: '1123456789abcdef0123456789abcdef01234567',
            },
            outcome: { checks: 3 },
          };
        },
      },
      criteria: {
        judge() {
          judgeCalls += 1;
          return { verdict: 'pass', gap: 'must not be used' };
        },
      },
    });

    const result = await kernel.verify(stale, 'reviewer:one');
    assert.equal(result.verdict, 'blocked');
    assert.match(result.gap, /Re-run the mechanism against the contract's exact subject identity/);
    assert.match(result.gap, /specRevision expected spec_version:revision-17/);
    assert.match(result.gap, /commitSha expected/);
    assert.equal(judgeCalls, 0);
  });

  it('passes governed override input to the judge without granting kernel override authority', async () => {
    const governedOverride = {
      decisionId: 'DEC-17',
      decidedBy: 'operator:security',
      rationale: 'Accepted compensating control for this exact revision.',
    };
    let received: unknown;
    const withOverride = contract({ verdict: 'fail', gap: 'unused' }, {
      governedOverride,
      criteria: {
        judge(_outcome, override) {
          received = override;
          return {
            verdict: 'blocked',
            gap: 'Validate DEC-17 through the governed decision owner before retrying.',
          };
        },
      },
    });

    const result = await kernel.verify(withOverride, 'hermes:assurance-service');
    assert.equal(received, governedOverride);
    assert.equal(result.verdict, 'blocked');
    assert.equal('governedOverride' in result, false);
    assert.equal('decisionId' in result, false);
  });

  it('blocks malformed judge output with an actionable remediation', async () => {
    const malformed = contract({ verdict: 'pass', gap: 'unused' }, {
      criteria: {
        judge: () => ({ verdict: 'pass', gap: '' }),
      },
    });

    const result = await kernel.verify(malformed, 'reviewer:one');
    assert.equal(result.verdict, 'blocked');
    assert.match(result.gap, /^Correct the verification criteria or governed input and retry judgment/);
  });
});
