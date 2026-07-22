// SPDX-License-Identifier: Apache-2.0

/** Regression coverage for fail-closed prompt delivery in execution-engine. */

import type { PtyCliCompatibility } from '../pty-cli-compat';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  injectPromptWithBracketedPaste,
} from '../interactive-pty-agent-adapter';

const PI_COMPATIBILITY: PtyCliCompatibility = {
  agentType: 'pi',
  checkedAt: '2026-07-22T00:00:00.000Z',
  binaryPath: '/usr/bin/pi-test-double',
  version: '1.0.0',
  ready: true,
  interactive: true,
  capabilities: {
    permissionBypass: false,
    permissionMode: false,
    model: true,
    thinkingBudget: false,
    effort: false,
    mcpConfig: false,
    attach: false,
    askForApproval: false,
    noAltScreen: false,
    textMode: true,
    noExtensions: true,
    tools: true,
    appendSystemPrompt: true,
    extension: true,
    provider: true,
    thinking: true,
    skill: true,
  },
  probes: { version: null, help: null },
  diagnostics: [],
};

describe('execution-engine prompt delivery hardening', () => {
  const previousPiBin = process.env.PI_BIN;

  beforeEach(() => {
    jest.resetModules();
    process.env.PI_BIN = '/usr/bin/pi-test-double';
  });

  afterEach(() => {
    if (previousPiBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = previousPiBin;
  });

  test('Pi PTY command carries a non-empty prompt for readiness-driven injection', () => {
    const { buildPtyCommand } = require('../execution-engine') as typeof import('../execution-engine');
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
      PI_COMPATIBILITY,
    );

    expect(command.command).toBe('/usr/bin/pi-test-double');
    expect(command.args).toEqual(expect.arrayContaining([
      '--mode', 'text', '--model', 'openai-codex/gpt-5.5', '--thinking', 'xhigh',
    ]));
    expect(command.args).not.toContain('--provider');
    expect(command.args).not.toContain('--print');
    expect(command.prompt).toBe(prompt);
  });

  test('interactive injection uses bounded bracketed paste followed by Enter', async () => {
    const writes: string[] = [];
    const prompt = 'Implement story US-001 with validation.';

    await injectPromptWithBracketedPaste(
      { write: (data: string) => writes.push(data) },
      prompt,
      { submitDelayMs: 0 },
    );

    expect(writes).toEqual([BRACKETED_PASTE_START, prompt, BRACKETED_PASTE_END, '\r']);
  });

  test('recognizes the Pi CLI no-prompt message as prompt delivery failure', () => {
    const { isPromptDeliveryFailureOutput } = require('../execution-engine') as typeof import('../execution-engine');

    expect(isPromptDeliveryFailureOutput('No prompt provided. Either specify one as an argument or pipe the prompt into stdin.')).toBe(true);
    expect(isPromptDeliveryFailureOutput('prompt_delivery_failed: empty prompt')).toBe(true);
    expect(isPromptDeliveryFailureOutput('regular provider rate limit')).toBe(false);
  });
});
