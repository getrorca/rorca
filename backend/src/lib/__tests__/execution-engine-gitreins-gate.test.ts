/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { decideGitReinsGateAction } from '../gitreins-gate';
import { defaultRorcaConfig, RorcaConfigSchema } from '../rorca-config';

describe('canonical execution-engine GitReins gate', () => {
  test('conservative workspace defaults disable the gate with bounded limits', () => {
    const config = defaultRorcaConfig();
    expect(config.execution.gitreins).toEqual({
      mode: 'disabled',
      timeoutMs: 120000,
      maxEvidenceBytes: 32768,
    });
  });

  test('accepts only bounded disabled/observe/enforce workspace configuration', () => {
    expect(RorcaConfigSchema.safeParse({ execution: { gitreins: { mode: 'observe' } } }).success)
      .toBe(true);
    expect(RorcaConfigSchema.safeParse({ execution: { gitreins: { mode: 'unsafe' } } }).success)
      .toBe(false);
    expect(RorcaConfigSchema.safeParse({ execution: { gitreins: { mode: 'enforce', timeoutMs: 9999999 } } }).success)
      .toBe(false);
  });

  test('observe/nonblocking results proceed while enforce failures retry then fail', () => {
    expect(decideGitReinsGateAction({ shouldBlock: false }, 1, 3)).toBe('proceed');
    expect(decideGitReinsGateAction({ shouldBlock: true }, 1, 3)).toBe('retry');
    expect(decideGitReinsGateAction({ shouldBlock: true }, 2, 3)).toBe('retry');
    expect(decideGitReinsGateAction({ shouldBlock: true }, 3, 3)).toBe('fail');
  });

  test('gate is structurally after review and before local/canonical pass handling', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'execution-engine.ts'), 'utf8');
    const successSection = source.indexOf('// CA-011: Adversarial review passes');
    const gate = source.indexOf('// GitReins blocking gate:', successSection);
    const localPass = source.indexOf('// All checks passed — mark story as done only after the GitReins gate.', gate);
    const canonicalPass = source.indexOf("emitWalEvent(config.port, 'story_passed'", gate);
    expect(successSection).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(successSection);
    expect(localPass).toBeGreaterThan(gate);
    expect(canonicalPass).toBeGreaterThan(localPass);
  });

  test('one shared gate call follows runAgent and is not inside an agent-specific branch', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'execution-engine.ts'), 'utf8');
    const callMatches = source.match(/await runGitReinsJudge\(\{/g) ?? [];
    expect(callMatches).toHaveLength(1);
    const agentResolution = source.indexOf('let effectiveAgent: AgentType = storyAgentOverride ?? resolveStoryAgent(story, config.agentType);');
    expect(agentResolution).toBeGreaterThan(-1);
    expect(source.indexOf('await runGitReinsJudge({')).toBeGreaterThan(agentResolution);
  });

  test('worktree execution judges effectiveCwd and stores worktree evidence before merge', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'execution-engine.ts'), 'utf8');
    expect(source).toContain('cwd: effectiveCwd');
    expect(source).toContain('worktree: gitReinsResult.worktree');
    expect(source.indexOf('await runGitReinsJudge({')).toBeLessThan(
      source.indexOf('// All checks passed — mark story as done only after the GitReins gate.'),
    );
  });
});
