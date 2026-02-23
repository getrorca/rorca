import { EventEmitter } from 'events';

// Build a fake child process returned by spawn
function fakeChild(stdoutData: string, stderrData: string, exitCode: number) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  // Simulate async data + close events
  setTimeout(() => {
    if (stdoutData) child.stdout.emit('data', Buffer.from(stdoutData));
    if (stderrData) child.stderr.emit('data', Buffer.from(stderrData));
    child.emit('close', exitCode);
  }, 0);

  return child;
}

const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: mockSpawn,
}));

describe('llm-client', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.doMock('child_process', () => ({ spawn: mockSpawn }));
  });

  test('getActiveProvider returns "claude-cli"', () => {
    const { getActiveProvider } = require('../llm-client');
    expect(getActiveProvider()).toBe('claude-cli');
  });

  test('getActiveModel returns "claude (subscription)"', () => {
    const { getActiveModel } = require('../llm-client');
    expect(getActiveModel()).toBe('claude (subscription)');
  });

  test('chatComplete returns text and usage from JSON output', async () => {
    const jsonOutput = JSON.stringify({
      result: 'LLM response',
      input_tokens: 100,
      output_tokens: 200,
    });
    mockSpawn.mockReturnValue(fakeChild(jsonOutput, '', 0));

    const { chatComplete } = require('../llm-client');
    const result = await chatComplete([{ role: 'user', content: 'hello' }]);

    expect(result.text).toBe('LLM response');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--print', '--output-format', 'json', 'hello']),
      expect.any(Object),
    );
  });

  test('chatComplete passes --model flag when model is provided', async () => {
    const jsonOutput = JSON.stringify({ result: 'ok', input_tokens: 10, output_tokens: 20 });
    mockSpawn.mockReturnValue(fakeChild(jsonOutput, '', 0));

    const { chatComplete } = require('../llm-client');
    await chatComplete([{ role: 'user', content: 'hi' }], 'claude-opus-4-6');

    const callArgs = mockSpawn.mock.calls[0];
    const args = callArgs[1] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('claude-opus-4-6');
  });

  test('chatComplete falls back to plain text when JSON parse fails', async () => {
    mockSpawn.mockReturnValue(fakeChild('plain text response', '', 0));

    const { chatComplete } = require('../llm-client');
    const result = await chatComplete([{ role: 'user', content: 'test' }]);

    expect(result.text).toBe('plain text response');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test('chatComplete concatenates multi-turn messages', async () => {
    const jsonOutput = JSON.stringify({ result: 'response', input_tokens: 5, output_tokens: 10 });
    mockSpawn.mockReturnValue(fakeChild(jsonOutput, '', 0));

    const { chatComplete } = require('../llm-client');
    await chatComplete([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow-up' },
    ]);

    const callArgs = mockSpawn.mock.calls[0];
    const prompt = callArgs[1][callArgs[1].length - 1]; // last arg is the prompt
    expect(prompt).toContain('first');
    expect(prompt).toContain('[Previous response: reply]');
    expect(prompt).toContain('follow-up');
  });

  test('chatComplete strips CLAUDECODE from env', async () => {
    process.env.CLAUDECODE = 'true';
    const jsonOutput = JSON.stringify({ result: 'ok', input_tokens: 1, output_tokens: 1 });
    mockSpawn.mockReturnValue(fakeChild(jsonOutput, '', 0));

    const { chatComplete } = require('../llm-client');
    await chatComplete([{ role: 'user', content: 'test' }]);

    const callArgs = mockSpawn.mock.calls[0];
    const env = callArgs[2].env;
    expect(env.CLAUDECODE).toBeUndefined();

    delete process.env.CLAUDECODE;
  });

  test('chatComplete rejects on non-zero exit code', async () => {
    mockSpawn.mockReturnValue(fakeChild('', 'error occurred', 1));

    const { chatComplete } = require('../llm-client');
    await expect(chatComplete([{ role: 'user', content: 'test' }]))
      .rejects.toThrow('claude exited with code 1');
  });

  test('isValidModel validates supported models', () => {
    const { isValidModel } = require('../llm-client');
    expect(isValidModel('claude-sonnet-4-5-20250929')).toBe(true);
    expect(isValidModel('claude-opus-4-6')).toBe(true);
    expect(isValidModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isValidModel('gpt-4o')).toBe(false);
    expect(isValidModel('')).toBe(false);
  });

  test('SUPPORTED_MODELS contains all three models', () => {
    const { SUPPORTED_MODELS } = require('../llm-client');
    expect(SUPPORTED_MODELS).toHaveLength(3);
    expect(SUPPORTED_MODELS).toContain('claude-sonnet-4-5-20250929');
    expect(SUPPORTED_MODELS).toContain('claude-opus-4-6');
    expect(SUPPORTED_MODELS).toContain('claude-haiku-4-5-20251001');
  });
});
