/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Response } from 'express';
import { createBoundedTopicSseSink } from '../sse-hub';

function responseDouble(writeResults: boolean[]): { response: Response; writes: string[]; end: jest.Mock } {
  const writes: string[] = [];
  const end = jest.fn(function endResponse(this: { writableEnded: boolean }) { this.writableEnded = true; });
  const value = {
    destroyed: false,
    writableEnded: false,
    socket: { writable: true },
    write: jest.fn((chunk: string) => {
      writes.push(chunk);
      return writeResults.shift() ?? true;
    }),
    end,
  };
  return { response: value as unknown as Response, writes, end };
}

describe('bounded topic SSE sink', () => {
  it('routes accepted frames through the exact response topic', () => {
    const { response, writes } = responseDouble([true]);
    const sink = createBoundedTopicSseSink(response);
    expect(sink.send({ id: 'cursor-1', event: 'chunk', data: 'YQ==' })).toBe(true);
    expect(writes).toEqual(['id: cursor-1\nevent: chunk\ndata: YQ==\n\n']);
    sink.close();
  });

  it('disconnects on first pressure signal with one retryable last-cursor frame', () => {
    const { response, writes, end } = responseDouble([false, false]);
    const sink = createBoundedTopicSseSink(response, 750);
    expect(sink.send({ id: 'cursor-2', event: 'chunk', data: 'Yg==' }, 'cursor-1')).toBe(false);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain('retry: 750');
    expect(writes[1]).toContain('event: stream_disconnect');
    expect(writes[1]).toContain('"cursor":"cursor-1"');
    expect(end).toHaveBeenCalledTimes(1);
    expect(sink.send({ event: 'chunk', data: 'must-not-buffer' }, 'cursor-1')).toBe(false);
    expect(writes).toHaveLength(2);
  });
});
