/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import {
  attachJsonlLineReader,
  isHostBoundCompletionStatusValid,
  materializeHostBoundCompletionStatus,
  shouldResolvePiRpcStory,
  stageHostBoundCompletionStatus,
} from '../execution-engine';

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

  test('replaces a model-corrupted receipt with exact host-bound completion authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-host-completion-'));
    const markerFile = path.join(root, '.rorca', 'progress', 'run-7', 'AFM-001.done.json');
    const binding = {
      markerFile,
      completionMarker: '__RORCA_STORY_DONE_7_AFM-001__',
      generationRef: {
        generationId: '8d4fc987-8c08-4dfd-aa0e-366fd1239495',
        generationToken: 'fc601067-454e-4208-b121-d5969f8662de',
      },
      storyId: 'AFM-001',
      runId: 7,
      attempt: 1,
    };

    try {
      const stagedFile = stageHostBoundCompletionStatus(binding);
      expect(JSON.parse(fs.readFileSync(stagedFile, 'utf8'))).toEqual({
        storyId: 'AFM-001',
        runId: 7,
        marker: '__RORCA_STORY_DONE_7_AFM-001__',
        generationId: '8d4fc987-8c08-4dfd-aa0e-366fd1239495',
        generationToken: 'fc601067-454e-4208-b121-d5969f8662de',
        attempt: 1,
      });

      fs.writeFileSync(markerFile, JSON.stringify({
        storyId: 'AFM-001',
        runId: '7',
        marker: '__RORCA_STORY_DONE_7_AFM-001__',
        generatorId: '8c9867-c8c8-4b8d-ae0e-366fd12349f',
        generationToken: 'f06067-454e-4208-b',
        attempt: 1,
      }));
      expect(isHostBoundCompletionStatusValid(binding)).toBe(false);

      materializeHostBoundCompletionStatus(binding);
      expect(isHostBoundCompletionStatusValid(binding)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
