/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/index', () => ({ queryOne: jest.fn(), execute: jest.fn() }));

import { execute, queryOne } from '../../db/index';
import { completeRunnerJob } from '../execution-runner-jobs';

const runnerRow = {
  id: 'job-1',
  run_id: 42,
  environment_id: 'local-user',
  status: 'succeeded',
  payload: {},
  claimed_by: 'runner-1',
  claimed_at: null,
  started_at: null,
  completed_at: new Date(),
  result: {},
  error: null,
};

test('historical local-user transport success converges to failed instead of release_pending', async () => {
  (queryOne as jest.Mock).mockResolvedValue(runnerRow);
  (execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

  await completeRunnerJob({
    jobId: 'job-1',
    runnerId: 'runner-1',
    status: 'succeeded',
    result: { transportExitCode: 0 },
  });

  expect(execute).toHaveBeenCalledTimes(1);
  const [sql, params] = (execute as jest.Mock).mock.calls[0];
  expect(sql).toContain("THEN 'local_user_execution_unavailable'");
  expect(sql).not.toContain('release_pending');
  expect(params).toEqual([42, 'failed', 'succeeded']);
});
