/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { normalizeSsdlcContractJson } from '../ssdlc-contracts';
const mockTransaction = jest.fn();

jest.mock('../../db/index', () => ({
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

import {
  assertLifecycleDispatchClaim,
  claimLifecycleDispatch,
  parseLifecycleDispatchClaim,
  withLifecycleDispatchClaimLock,
  type LifecycleDispatchClaim,
} from '../lifecycle-dispatch-claim';

const SPEC_HASH = `sha256:${'a'.repeat(64)}`;
const REQUEST_HASH = `sha256:${'b'.repeat(64)}`;
const CLAIM_ID = '2a495349-8a0e-4c30-8fd1-68b46a6eb4cb';
const input = {
  workspaceId: 'workspace-1',
  specId: 'approved-spec',
  specHash: SPEC_HASH,
  compiledPlanId: '42',
  requestIdentity: 'pipeline:request-1',
  requestHash: REQUEST_HASH,
};
const row = {
  claim_id: CLAIM_ID,
  workspace_id: input.workspaceId,
  spec_slug: input.specId,
  spec_hash: input.specHash,
  compiled_plan_id: input.compiledPlanId,
  request_identity: input.requestIdentity,
  request_hash: input.requestHash,
};
const claim: LifecycleDispatchClaim = {
  schemaVersion: 'lifecycle-dispatch-claim.v1',
  claimId: CLAIM_ID,
  workspaceId: input.workspaceId,
  specId: input.specId,
  specHash: input.specHash,
  compiledPlanId: input.compiledPlanId,
  requestIdentity: input.requestIdentity,
  requestHash: input.requestHash,
};

describe('durable lifecycle dispatch claims', () => {
  beforeEach(() => jest.clearAllMocks());

  test('atomically inserts only through the exact current validated compiled plan', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });
    mockTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    await expect(claimLifecycleDispatch(input)).resolves.toEqual(claim);
    expect(String(query.mock.calls[1][0])).toContain('pg_advisory_xact_lock(hashtext($1), hashtext($2))');
    expect(String(query.mock.calls[2][0])).toContain("plan.provenance_json->>'specHash' = $4");
    expect(String(query.mock.calls[2][0])).toContain("plan.validation_status = 'validated'");
    expect(String(query.mock.calls[2][0])).toContain('plan.is_current = TRUE');
  });

  test('exact replay deterministically reuses the immutable claim after rechecking current plan', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ claim_id: CLAIM_ID }] });
    mockTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    await expect(claimLifecycleDispatch(input)).resolves.toEqual(claim);
    expect(String(query.mock.calls[4][0])).toContain('JOIN ssdlc_compiled_plans plan');
    expect(String(query.mock.calls[4][0])).toContain('FOR SHARE OF plan');
  });

  test('conflicting reuse fails closed before any later dispatch assertion', async () => {
    const conflicting = { ...row, request_hash: `sha256:${'c'.repeat(64)}` };
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [conflicting] });
    mockTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    await expect(claimLifecycleDispatch(input)).rejects.toThrow(
      'Lifecycle dispatch request identity is already bound to a different immutable claim',
    );
    expect(query).toHaveBeenCalledTimes(4);
  });

  test('plan/spec identity changing before claim insertion produces no claim', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    await expect(claimLifecycleDispatch(input)).rejects.toThrow(
      'Lifecycle dispatch claim could not prove the exact current validated plan',
    );
  });

  test('publication assertion rejects a claim after the selected plan stops being current', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });
    mockTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    await expect(assertLifecycleDispatchClaim(claim)).rejects.toThrow(
      'Lifecycle dispatch claim no longer matches the exact current validated plan',
    );
    expect(String(query.mock.calls[0][0])).toContain('FOR SHARE OF plan');
  });

  test('binds execution to the exact persisted compiled plan payload', async () => {
    const plan = { planId: 'plan-1', workspaceId: input.workspaceId, specId: input.specId };
    const planHash = `sha256:${createHash('sha256').update(normalizeSsdlcContractJson(plan), 'utf8').digest('hex')}`;
    const matchingQuery = jest.fn().mockResolvedValueOnce({
      rows: [{ claim_id: CLAIM_ID, plan_json: plan }],
    });
    mockTransaction.mockImplementationOnce(
      async (fn: (client: { query: typeof matchingQuery }) => Promise<unknown>) => fn({ query: matchingQuery }),
    );

    await expect(assertLifecycleDispatchClaim(claim, undefined, planHash)).resolves.toBeUndefined();
    expect(String(matchingQuery.mock.calls[0][0])).toContain('plan.plan_json');

    const changedQuery = jest.fn().mockResolvedValueOnce({
      rows: [{ claim_id: CLAIM_ID, plan_json: { ...plan, planId: 'plan-2' } }],
    });
    mockTransaction.mockImplementationOnce(
      async (fn: (client: { query: typeof changedQuery }) => Promise<unknown>) => fn({ query: changedQuery }),
    );
    await expect(assertLifecycleDispatchClaim(claim, undefined, planHash)).rejects.toThrow(
      'Lifecycle execution contract does not match the exact claimed compiled plan',
    );
  });

  test('holds the per-spec plan lock through the irreversible action', async () => {
    const order: string[] = [];
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock(hashtext')) order.push('lock');
      else order.push('assert');
      return sql.includes('JOIN ssdlc_compiled_plans')
        ? { rows: [{ claim_id: CLAIM_ID }] }
        : { rows: [] };
    });
    mockTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => {
      const result = await fn({ query });
      order.push('commit');
      return result;
    });

    await withLifecycleDispatchClaimLock(claim, () => order.push('side-effect'));

    expect(order).toEqual(['lock', 'assert', 'side-effect', 'commit']);
  });

  test('does not cross the side-effect boundary when plan identity changed while waiting for the lock', async () => {
    const sideEffect = jest.fn();
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockTransaction.mockImplementationOnce(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));

    await expect(withLifecycleDispatchClaimLock(claim, sideEffect)).rejects.toThrow(
      'Lifecycle dispatch claim no longer matches the exact current validated plan',
    );
    expect(sideEffect).not.toHaveBeenCalled();
  });

  test('stored run linkage accepts only the complete strict claim envelope', () => {
    expect(parseLifecycleDispatchClaim(claim)).toEqual(claim);
    expect(parseLifecycleDispatchClaim({ ...claim, compiledPlanId: undefined })).toBeUndefined();
    expect(parseLifecycleDispatchClaim({ ...claim, extra: true })).toBeUndefined();
    expect(parseLifecycleDispatchClaim({ ...claim, requestHash: 'not-a-hash' })).toBeUndefined();
  });
});
