/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractTokenUsage } from '../execution-engine';

describe('extractTokenUsage – pi native cost parsing', () => {
  test('parses cumulative pi token and cost data from token log lines', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-parse-'));
    const logFile = path.join(tmpDir, 'story.log');

    try {
      fs.writeFileSync(
        logFile,
        [
          '[Token] input=120 output=30 cost=0.0125 cumulative_input=120 cumulative_output=30 cumulative_cost=0.0125 turn=1',
          '[Token] input=80 output=20 cost=0 cumulative_input=200 cumulative_output=50 cumulative_cost=0.0125 turn=2',
        ].join('\n'),
        'utf8',
      );

      const usage = extractTokenUsage(logFile, 'pi', 'pi/openai/gpt-4.1', '', tmpDir);
      expect(usage.inputTokens).toBe(200);
      expect(usage.outputTokens).toBe(50);
      expect(usage.model).toBe('pi/openai/gpt-4.1');
      expect(usage.costUsd).toBe(0.0125);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('preserves zero-cost pi runs as 0 instead of nullish fallback', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-zero-cost-'));
    const logFile = path.join(tmpDir, 'story.log');

    try {
      fs.writeFileSync(
        logFile,
        '[Token] input=40 output=10 cost=0 cumulative_input=40 cumulative_output=10 cumulative_cost=0 turn=1\n',
        'utf8',
      );

      const usage = extractTokenUsage(logFile, 'pi', 'pi/omlx/local', '', tmpDir);
      expect(usage.inputTokens).toBe(40);
      expect(usage.outputTokens).toBe(10);
      expect(usage.costUsd).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
