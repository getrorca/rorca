/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Regression coverage for fail-closed prompt delivery in execution-engine.
 */

import type { AgentType } from '../config';
import type { PtyCliCapability, PtyCliCompatibility } from '../pty-cli-compat';

const CAPABILITIES: PtyCliCapability[] = [
  'permissionBypass', 'model', 'thinkingBudget', 'effort', 'mcpConfig', 'attach', 'askForApproval', 'noAltScreen',
  'textMode', 'noExtensions', 'tools', 'appendSystemPrompt', 'extension', 'provider', 'thinking', 'skill',
];

describe('execution-engine prompt delivery hardening', () => {
  const previousPiBin = process.env.PI_BIN;

  function verifiedCompatibility(agentType: AgentType, binaryPath: string, enabled: PtyCliCapability[] = []): PtyCliCompatibility {
    return {
      agentType,
      binaryPath,
      version: 'test',
      ready: true,
      interactive: true,
      capabilities: Object.fromEntries(CAPABILITIES.map((key) => [key, enabled.includes(key)])) as PtyCliCompatibility['capabilities'],
      diagnostics: [],
      probes: { version: null, help: null },
      checkedAt: new Date(0).toISOString(),
    };
  }

  function loadExecutionEngine(): typeof import('../execution-engine') {
    try {
      return require('../execution-engine') as typeof import('../execution-engine');
    } catch (error) {
      const message = error instanceof Error ? (error.stack || error.message) : String(error);
      // Keep this diagnostic in the test: ts-jest can otherwise report an empty
      // failure when a module-level import throws before assertions run.
      console.error(message);
      throw error;
    }
  }

  beforeAll(() => {
    process.env.PI_BIN = '/usr/bin/pi-test-double';
  });

  afterAll(() => {
    if (previousPiBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = previousPiBin;
  });

  test('Pi PTY command uses interactive text mode and leaves prompt for bracketed paste injection', () => {
    const { buildPtyCommand } = loadExecutionEngine();

    const prompt = 'Implement story US-001 with validation.';
    const command = buildPtyCommand(
      'pi',
      prompt,
      process.cwd(),
      'openai-codex/gpt-5.5',
      null,
      undefined,
      undefined,
      'xhigh',
      undefined,
      [],
      verifiedCompatibility('pi', '/usr/bin/pi-test-double', ['textMode', 'model', 'thinking']),
    );

    expect(command.command.endsWith('/pi-test-double') || command.command === '/usr/bin/pi-test-double').toBe(true);
    expect(command.args).toEqual(expect.arrayContaining(['--mode', 'text']));
    expect(command.args).not.toContain('--print');
    expect(command.args.some((arg: string) => arg.startsWith('@'))).toBe(false);
    expect(command.prompt).toBe(prompt);
  });

  test('PTY commands avoid non-interactive semantic launch flags', () => {
    const { buildPtyCommand } = loadExecutionEngine();
    const cwd = process.cwd();

    const claude = buildPtyCommand('claude', 'prompt', cwd, null, null, undefined, undefined, undefined, undefined, [], verifiedCompatibility('claude', '/fake/claude'));
    expect(claude.args).not.toContain('--print');
    expect(claude.args).not.toContain('--output-format');

    const opencode = buildPtyCommand('opencode', 'prompt', cwd, null, null, undefined, undefined, undefined, undefined, [], verifiedCompatibility('opencode', '/fake/opencode'));
    expect(opencode.args).not.toContain('run');
    expect(opencode.args).not.toContain('--format');

    const codex = buildPtyCommand('codex', 'prompt', cwd, null, null, undefined, undefined, undefined, undefined, [], verifiedCompatibility('codex', '/fake/codex', ['askForApproval', 'noAltScreen']));
    expect(codex.args).not.toContain('exec');
    expect(codex.args).not.toContain('--approval-mode');
    expect(codex.args).toEqual(expect.arrayContaining(['--ask-for-approval', 'on-request', '--no-alt-screen']));
  });

  test('recognizes the Pi CLI no-prompt message as prompt delivery failure', () => {
    const { isPromptDeliveryFailureOutput } = loadExecutionEngine();

    expect(isPromptDeliveryFailureOutput('No prompt provided. Either specify one as an argument or pipe the prompt into stdin.')).toBe(true);
    expect(isPromptDeliveryFailureOutput('prompt_delivery_failed: empty prompt')).toBe(true);
    expect(isPromptDeliveryFailureOutput('regular provider rate limit')).toBe(false);
  });
});
