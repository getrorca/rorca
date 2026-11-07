/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractTokenUsage } from '../execution-engine';

describe.each(['pi', 'omp'] as const)('extractTokenUsage – %s native cost parsing', (agent) => {
  test('parses cumulative token data idempotently when a final sample is replayed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-parse-'));
    const logFile = path.join(tmpDir, 'story.log');

    try {
      fs.writeFileSync(
        logFile,
        [
          '[Token] input=120 output=30 cost=0.0125 cumulative_input=120 cumulative_output=30 cumulative_cost=0.0125 turn=1',
          '[Token] input=80 output=20 cost=0 cumulative_input=200 cumulative_output=50 cumulative_cost=0.0125 turn=2',
          '[Token] input=80 output=20 cost=0 cumulative_input=200 cumulative_output=50 cumulative_cost=0.0125 turn=2',
        ].join('\n'),
        'utf8',
      );

      const usage = extractTokenUsage(logFile, agent, 'pi/openai/gpt-4.1', '', tmpDir);
      expect(usage.inputTokens).toBe(200);
      expect(usage.outputTokens).toBe(50);
      expect(usage.model).toBe('pi/openai/gpt-4.1');
      expect(usage.costUsd).toBe(0.0125);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('parses cumulative OMP token and cost data emitted by the Pi RPC adapter', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-cost-parse-'));
    const logFile = path.join(tmpDir, 'story.log');

    try {
      fs.writeFileSync(
        logFile,
        [
          '[OmpEvent:stdout] {"type":"turn_end"}',
          '[Token] input=120 output=30 cost=0.0125 cumulative_input=120 cumulative_output=30 cumulative_cost=0.0125 turn=1',
          '[Token] input=80 output=20 cost=0.005 cumulative_input=200 cumulative_output=50 cumulative_cost=0.0175 turn=2',
        ].join('\n'),
        'utf8',
      );

      const usage = extractTokenUsage(logFile, 'omp', 'openai-codex/gpt-5.6-sol', '', tmpDir);
      expect(usage).toEqual({
        inputTokens: 200,
        outputTokens: 50,
        model: 'openai-codex/gpt-5.6-sol',
        costUsd: 0.0175,
      });
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

      const usage = extractTokenUsage(logFile, agent, 'pi/omlx/local', '', tmpDir);
      expect(usage.inputTokens).toBe(40);
      expect(usage.outputTokens).toBe(10);
      expect(usage.costUsd).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('sums the final cumulative sample from each appended subprocess launch exactly once', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-launch-cost-'));
    const logFile = path.join(tmpDir, 'story.log');

    try {
      fs.writeFileSync(logFile, [
        '[Token] launch=launch-a provider=openai-codex model=gpt-5.6-sol input=100 output=10 cost=0.01 cumulative_input=100 cumulative_output=10 cumulative_cost=0.01 turn=1',
        '[Token] launch=launch-a provider=openai-codex model=gpt-5.6-sol input=50 output=5 cost=0.005 cumulative_input=150 cumulative_output=15 cumulative_cost=0.015 turn=2',
        // Replayed sample for the same launch is a replacement, never another charge.
        '[Token] launch=launch-a provider=openai-codex model=gpt-5.6-sol input=50 output=5 cost=0.005 cumulative_input=150 cumulative_output=15 cumulative_cost=0.015 turn=2',
        '[Token] launch=launch-b provider=anthropic model=claude-sonnet-4-5 input=40 output=8 cost=0.02 cumulative_input=40 cumulative_output=8 cumulative_cost=0.02 turn=1',
        '[Token] launch=launch-b provider=anthropic model=claude-sonnet-4-5 input=10 output=2 cost=0 cumulative_input=50 cumulative_output=10 cumulative_cost=0.02 turn=2',
      ].join('\n'));

      const usage = extractTokenUsage(logFile, agent, null, '', tmpDir);
      expect(usage).toEqual({
        inputTokens: 200,
        outputTokens: 25,
        model: 'anthropic/claude-sonnet-4-5',
        provider: 'anthropic',
        costUsd: 0.035,
      });
      expect(extractTokenUsage(logFile, agent, null, '', tmpDir)).toEqual(usage);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('keeps legacy retry launches separate when cumulative turn counters restart', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-legacy-retry-'));
    const logFile = path.join(tmpDir, 'story.log');

    try {
      fs.writeFileSync(logFile, [
        '[Token] input=70 output=7 cost=0.007 cumulative_input=70 cumulative_output=7 cumulative_cost=0.007 turn=1',
        '[Token] input=30 output=3 cost=0.003 cumulative_input=100 cumulative_output=10 cumulative_cost=0.01 turn=2',
        '[Token] input=20 output=4 cost=0 cumulative_input=20 cumulative_output=4 cumulative_cost=0 turn=1',
      ].join('\n'));

      const usage = extractTokenUsage(logFile, agent, 'fallback/provider-model', '', tmpDir);
      expect(usage.inputTokens).toBe(120);
      expect(usage.outputTokens).toBe(14);
      expect(usage.costUsd).toBe(0.01);
      expect(usage.model).toBe('fallback/provider-model');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('parses the OMP canary attribution and nonzero totals with a null configured model', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-canary-token-'));
    const logFile = path.join(tmpDir, 'story.log');

    try {
      fs.writeFileSync(logFile, [
        '[OmpEvent:stdout] {"type":"turn_end","message":{"provider":"openai-codex","model":"gpt-5.6-sol","usage":{"input":42673,"output":72,"cost":{"total":0.2155253}}}}',
        '[Token] launch=canary-015 provider=openai-codex model=gpt-5.6-sol input=42673 output=72 cost=0.2155253 cumulative_input=42673 cumulative_output=72 cumulative_cost=0.2155253 turn=1',
      ].join('\n'));

      const usage = extractTokenUsage(logFile, agent, null, '', tmpDir);
      expect(usage.inputTokens).toBe(42673);
      expect(usage.outputTokens).toBe(72);
      expect(usage.model).toBe('openai-codex/gpt-5.6-sol');
      expect(usage.provider).toBe('openai-codex');
      expect(usage.costUsd).toBeCloseTo(0.2155253, 7);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('attributes mixed-provider fallback totals to exact final launch metadata', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mixed-provider-cost-'));
    const logFile = path.join(tmpDir, 'story.log');

    try {
      fs.writeFileSync(logFile, [
        '[Token] launch=primary provider=anthropic model=claude-sonnet-4-5 input=10 output=2 cost=0.01 cumulative_input=10 cumulative_output=2 cumulative_cost=0.01 turn=1',
        '[Token] launch=fallback provider=openai-codex model=gpt-5.6-sol input=20 output=3 cost=0.02 cumulative_input=20 cumulative_output=3 cumulative_cost=0.02 turn=1',
      ].join('\n'));

      expect(extractTokenUsage(logFile, agent, null, '', tmpDir)).toEqual({
        inputTokens: 30,
        outputTokens: 5,
        model: 'openai-codex/gpt-5.6-sol',
        provider: 'openai-codex',
        costUsd: 0.03,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
