/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockExecute = jest.fn();

jest.mock('../../db/index', () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('../sse-hub', () => ({
  subscribe: jest.fn(() => jest.fn()),
}));

import { StoryLogFollower } from '../story-log-follower';

type TestTailState = {
  logFile: string;
  offset: number;
  sequence: number;
  timer: ReturnType<typeof setInterval>;
  lineBuf: string;
  activeRead: Promise<void> | null;
};

test('serializes overlapping reads and coalesces Pi event deltas into completed messages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-story-log-follower-'));
  const logFile = path.join(root, 'story.log');
  const state: TestTailState = {
    logFile,
    offset: 0,
    sequence: 1,
    timer: setInterval(() => undefined, 60_000),
    lineBuf: '',
    activeRead: null,
  };

  let releaseFirstWrite!: () => void;
  const firstWrite = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
  mockExecute
    .mockImplementationOnce(async () => firstWrite)
    .mockResolvedValue({ rowCount: 1 });

  fs.writeFileSync(logFile, [
    '[PiEvent:stdout] {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ignored"}}',
    'ignored[PiEvent:stdout] {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"completed message"}]}}',
    '[Tool] bash done (0)',
    '',
  ].join('\n'));

  const follower = new StoryLogFollower();
  const schedule = (follower as unknown as {
    scheduleTailRead(runId: number, storyId: string, tail: TestTailState): Promise<void>;
  }).scheduleTailRead.bind(follower);

  try {
    const first = schedule(41, 'STORY-1', state);
    const overlapping = schedule(41, 'STORY-1', state);
    expect(overlapping).toBe(first);

    await new Promise(resolve => setImmediate(resolve));
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0]?.[1]).toEqual([41, 'STORY-1', 'completed message', 1]);

    releaseFirstWrite();
    await Promise.all([first, overlapping]);

    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute.mock.calls[1]?.[1]).toEqual([41, 'STORY-1', '[Tool] bash done (0)', 2]);
    expect(state.activeRead).toBeNull();

    fs.appendFileSync(logFile, '[Token] turn=1\n');
    await schedule(41, 'STORY-1', state);
    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(mockExecute.mock.calls[2]?.[1]).toEqual([41, 'STORY-1', '[Token] turn=1', 3]);
  } finally {
    clearInterval(state.timer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
