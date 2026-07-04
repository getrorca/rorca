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

    expect(command.command).toBe('/usr/bin/pi-test-double');
    expect(command.args).toContain('run');
    expect(command.args).toContain('--jsonl');
    expect(command.args.some((arg: string) => arg.startsWith('@'))).toBe(false);
    expect(command.prompt).toBe(prompt);
    expect(command.writePromptToStdin).toBe(true);
  });

  test('recognizes the Pi CLI no-prompt message as prompt delivery failure', () => {
    const { isPromptDeliveryFailureOutput } = require('../execution-engine') as typeof import('../execution-engine');

    expect(isPromptDeliveryFailureOutput('No prompt provided. Either specify one as an argument or pipe the prompt into stdin.')).toBe(true);
    expect(isPromptDeliveryFailureOutput('prompt_delivery_failed: empty prompt')).toBe(true);
    expect(isPromptDeliveryFailureOutput('regular provider rate limit')).toBe(false);
  });
});
