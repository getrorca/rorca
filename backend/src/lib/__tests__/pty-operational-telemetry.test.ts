/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

const executeMock = jest.fn<Promise<{ rowCount: number }>, [string, unknown[] | undefined]>()
  .mockResolvedValue({ rowCount: 1 });
const broadcastTopicMock = jest.fn();
const infoMock = jest.fn();
const warnMock = jest.fn();

jest.mock('../../db/index', () => ({
  execute: (sql: string, params?: unknown[]) => executeMock(sql, params),
}));
jest.mock('../sse-hub', () => ({
  broadcastTopic: (...args: unknown[]) => broadcastTopicMock(...args),
}));
jest.mock('../logger', () => ({
  logger: { info: (...args: unknown[]) => infoMock(...args), warn: (...args: unknown[]) => warnMock(...args) },
}));

import {
  PTY_OPERATIONS_HEALTH_TOPIC,
  recordPtyByteTelemetry,
} from '../pty-operational-telemetry';

describe('pty operational telemetry', () => {
  beforeEach(() => {
    executeMock.mockClear();
    broadcastTopicMock.mockClear();
    infoMock.mockClear();
    warnMock.mockClear();
  });

  test('records byte accounting without feeding per-chunk logs back into captured run output', () => {
    recordPtyByteTelemetry(
      { generationId: 'generation-1', runId: 42, storyId: 'BBM-010' },
      'transcripted',
      'transcript',
      128,
      { retained: true },
    );

    expect(broadcastTopicMock).toHaveBeenCalledWith(PTY_OPERATIONS_HEALTH_TOPIC, expect.objectContaining({
      event: 'byte_accounting',
      byte_count: 128,
      labels: { byte_class: 'transcripted', component: 'transcript' },
    }));
    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pty_capture_telemetry'),
      expect.arrayContaining(['generation-1', 42, 'BBM-010', 'transcripted', 128]),
    );
    expect(infoMock).not.toHaveBeenCalled();
  });

  test('ignores zero-byte events without broadcasting or persisting', () => {
    recordPtyByteTelemetry(
      { generationId: 'generation-1', runId: 42, storyId: 'BBM-010' },
      'transcripted',
      'transcript',
      0,
    );

    expect(broadcastTopicMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(infoMock).not.toHaveBeenCalled();
  });
});
