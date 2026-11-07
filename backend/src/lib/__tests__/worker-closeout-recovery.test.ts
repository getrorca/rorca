/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const query = jest.fn();
const inspectRunHostAuthority = jest.fn();
const persistHostRunCloseout = jest.fn();
const prepareRunReleaseIntent = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => query(...args),
}));
jest.mock('../run-host-authority', () => ({
  inspectRunHostAuthority: (...args: unknown[]) => inspectRunHostAuthority(...args),
}));
jest.mock('../run-closeout-authority', () => ({
  persistHostRunCloseout: (...args: unknown[]) => persistHostRunCloseout(...args),
}));
jest.mock('../release-authority', () => ({
  prepareRunReleaseIntent: (...args: unknown[]) => prepareRunReleaseIntent(...args),
}));

import { recoverBranchOnlyWorkerCloseouts } from '../worker-closeout-recovery';

const authority = {
  runId: 41,
  complete: true,
  closeoutEligible: true,
  releaseEligible: true,
  finalCommitSha: 'a'.repeat(40),
  invalidReason: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  query.mockResolvedValue([{ id: 41 }]);
  inspectRunHostAuthority.mockResolvedValue(authority);
  persistHostRunCloseout.mockResolvedValue({ id: 91, identityHash: 'b'.repeat(64) });
  prepareRunReleaseIntent.mockResolvedValue({ runId: 41 });
});

test('recovers only the SQL-fenced branch-only no-send closeout path', async () => {
  await expect(recoverBranchOnlyWorkerCloseouts()).resolves.toEqual({
    scanned: 1,
    recovered: 1,
    blocked: [],
  });

  const sql = String(query.mock.calls[0][0]);
  expect(sql).toContain("pr.summary = 'worker_closeout_failed'");
  expect(sql).toContain("pr.merge_strategy = 'branch-only'");
  expect(sql).toContain('pr.auto_merge = FALSE');
  expect(persistHostRunCloseout).toHaveBeenCalledWith({
    runId: 41,
    status: 'done',
    terminalizeRun: false,
  });
  expect(prepareRunReleaseIntent).toHaveBeenCalledWith({
    hostAuthority: authority,
    mergeStrategy: 'branch-only',
    autoMerge: false,
    externalSend: false,
  });
});

test('fails closed without trusted writes when exact authority is incomplete', async () => {
  inspectRunHostAuthority.mockResolvedValue({
    ...authority,
    closeoutEligible: false,
    releaseEligible: false,
    invalidReason: 'outbox incomplete',
  });

  await expect(recoverBranchOnlyWorkerCloseouts()).resolves.toEqual({
    scanned: 1,
    recovered: 0,
    blocked: [{ runId: 41, reason: 'outbox incomplete' }],
  });
  expect(persistHostRunCloseout).not.toHaveBeenCalled();
  expect(prepareRunReleaseIntent).not.toHaveBeenCalled();
});

test('isolates one blocked candidate and continues bounded recovery', async () => {
  query.mockResolvedValue([{ id: 41 }, { id: 42 }]);
  inspectRunHostAuthority
    .mockRejectedValueOnce(new Error('transient authority read failed'))
    .mockResolvedValueOnce({ ...authority, runId: 42 });

  await expect(recoverBranchOnlyWorkerCloseouts(2)).resolves.toEqual({
    scanned: 2,
    recovered: 1,
    blocked: [{ runId: 41, reason: 'transient authority read failed' }],
  });
  expect(persistHostRunCloseout).toHaveBeenCalledWith({
    runId: 42,
    status: 'done',
    terminalizeRun: false,
  });
});

test.each([0, 1001, 1.5])('rejects invalid recovery bound %p', async (limit) => {
  await expect(recoverBranchOnlyWorkerCloseouts(limit)).rejects.toThrow('between 1 and 1000');
  expect(query).not.toHaveBeenCalled();
});
