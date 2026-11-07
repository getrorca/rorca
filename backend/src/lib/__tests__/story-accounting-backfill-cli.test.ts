/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockRecompute = jest.fn(async () => [{ receiptHash: 'a'.repeat(64) }]);
const mockRelease = jest.fn();
const mockEnd = jest.fn(async () => undefined);
const mockConnect = jest.fn(async () => ({ release: mockRelease }));

jest.mock('../story-accounting-backfill', () => ({
  recomputeFalseZeroStoryAccounting: mockRecompute,
}));
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({ connect: mockConnect, end: mockEnd })),
}));

import { parseBackfillCliArgs, runBackfillCli } from '../../../scripts/backfill-story-accounting';

describe('story accounting owner CLI', () => {
  beforeEach(() => jest.clearAllMocks());

  test('requires one bounded canonical run identity', () => {
    expect(() => parseBackfillCliArgs([])).toThrow('--run');
    expect(() => parseBackfillCliArgs(['--run', 'all'])).toThrow('--run');
    expect(parseBackfillCliArgs(['--run', '42', '--story', 'US-1'])).toEqual({
      runId: '42', storyId: 'US-1', apply: false,
    });
  });

  test('connects only with migration-owner credentials and invokes preview/apply explicitly', async () => {
    await expect(runBackfillCli(['--run', '42', '--story', 'US-1', '--apply'], {
      RORCA_MIGRATION_DATABASE_URL: 'postgres://migration-owner/db',
    } as NodeJS.ProcessEnv)).resolves.toEqual([{ receiptHash: 'a'.repeat(64) }]);
    expect(mockRecompute).toHaveBeenCalledWith(expect.anything(), {
      runId: '42', storyId: 'US-1', apply: true,
    });
    expect(mockRelease).toHaveBeenCalled();
    expect(mockEnd).toHaveBeenCalled();
  });
});
