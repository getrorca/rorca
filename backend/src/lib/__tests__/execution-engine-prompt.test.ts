// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for fail-closed prompt delivery in execution-engine.
 */

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

  test('Pi PTY command pipes a non-empty prompt to stdin instead of relying on @file argv', () => {
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
    );

    expect(command.command).toBe('/bin/bash');
    expect(command.args.join(' ')).toContain('/usr/bin/pi-test-double');
    expect(command.args.join(' ')).toContain('--print');
    expect(command.args.join(' ')).toContain('--mode');
    expect(command.args.join(' ')).toContain('text');
    expect(command.args.join(' ')).not.toContain('--jsonl');
    expect(command.prompt).toBe('');
    expect(command.writePromptToStdin).toBe(false);
  });

  test('Pi native PTY command starts interactive Pi and pastes the prompt without --print', () => {
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
      true,
    );

    expect(command.command).toBe('/usr/bin/pi-test-double');
    expect(command.args).not.toContain('--print');
    expect(command.args).toEqual(expect.arrayContaining(['--mode', 'text']));
    expect(command.prompt).toContain(prompt);
    expect(command.prompt).toContain('\u001b[200~');
    expect(command.promptTerminator).toBe('\r');
    expect(command.sendEofAfterPrompt).toBe(false);
  });

  test('recognizes the Pi CLI no-prompt message as prompt delivery failure', () => {
    const { isPromptDeliveryFailureOutput } = require('../execution-engine') as typeof import('../execution-engine');

    expect(isPromptDeliveryFailureOutput('No prompt provided. Either specify one as an argument or pipe the prompt into stdin.')).toBe(true);
    expect(isPromptDeliveryFailureOutput('prompt_delivery_failed: empty prompt')).toBe(true);
    expect(isPromptDeliveryFailureOutput('regular provider rate limit')).toBe(false);
  });
});
