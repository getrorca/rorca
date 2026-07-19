/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { PassThrough } from 'stream';
import { attachJsonlLineReader, shouldResolvePiRpcStory } from '../execution-engine';

describe('execution-engine Pi RPC lifecycle', () => {
  test('buffers partial JSONL chunks and preserves strict LF ordering', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const detach = attachJsonlLineReader(stream, line => lines.push(line));

    stream.write('{"type":"message_up');
    expect(lines).toEqual([]);
    stream.write('date","delta":"a\\u2028b"}\n{"type":"agent_');
    expect(lines).toEqual(['{"type":"message_update","delta":"a\\u2028b"}']);
    const ended = new Promise<void>(resolve => stream.once('end', resolve));
    stream.end('settled"}');
    await ended;
    expect(lines).toEqual([
      '{"type":"message_update","delta":"a\\u2028b"}',
      '{"type":"agent_settled"}',
    ]);
    detach();
  });

  test('does not treat turn_end as terminal story completion', () => {
    expect(shouldResolvePiRpcStory('turn_end')).toBe(false);
  });

  test('does not resolve on agent_end because retry/compaction may continue', () => {
    expect(shouldResolvePiRpcStory('agent_end')).toBe(false);
  });

  test('waits for documented agent_settled before resolving the story turn', () => {
    expect(shouldResolvePiRpcStory('agent_settled')).toBe(true);
  });
});
