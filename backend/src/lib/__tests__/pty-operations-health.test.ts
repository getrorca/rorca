/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const queryOneMock = jest.fn();
const queryMock = jest.fn();
const executeMock = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  query: (...args: unknown[]) => queryMock(...args),
  execute: (...args: unknown[]) => executeMock(...args),
}));
jest.mock('../pty-operational-telemetry', () => ({
  getLastPtyReplayLatencyMs: jest.fn(() => null),
  publishPtyOperationsHealthEvent: jest.fn(),
}));
jest.mock('../pty-feature-flags', () => ({ getPtyFeatureControls: jest.fn(() => ({})) }));

import { getPtyOperationsHealth } from '../pty-operations';

function aggregates(overrides: Record<string, unknown> = {}) {
  return {
    observed_bytes: 10, archived_bytes: 10, transcripted_bytes: 10,
    compacted_bytes: 0, dropped_bytes: 0, unrecoverable_bytes: 0,
    retained_replay_bytes: 10, checkpoint_age_ms: null, transcript_lag_ms: null,
    replay_storage_bytes: 10, checkpoint_storage_bytes: 0, transcript_storage_bytes: 10,
    archive_storage_bytes: 10, archive_complete_segments: 1,
    archive_missing_segments: 0, archive_corrupt_segments: 0, archive_failed_manifests: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  queryOneMock
    .mockResolvedValueOnce({ schema_version: 1, minimum_reader_version: 1, mutation_state: 'ready', diagnostic: '', updated_at: new Date().toISOString() })
    .mockResolvedValueOnce(aggregates());
});

test('complete archive accounting reports healthy', async () => {
  await expect(getPtyOperationsHealth()).resolves.toMatchObject({ status: 'healthy' });
});

test.each([
  ['failed manifest', { archive_failed_manifests: 1 }],
  ['unrecoverable bytes', { unrecoverable_bytes: 5 }],
  ['missing segment', { archive_missing_segments: 1 }],
  ['corrupt segment', { archive_corrupt_segments: 1 }],
])('%s degrades PTY operations health', async (_label, override) => {
  queryOneMock.mockReset()
    .mockResolvedValueOnce({ schema_version: 1, minimum_reader_version: 1, mutation_state: 'ready', diagnostic: '', updated_at: new Date().toISOString() })
    .mockResolvedValueOnce(aggregates(override));
  await expect(getPtyOperationsHealth()).resolves.toMatchObject({ status: 'degraded' });
});
