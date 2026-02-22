import { promisify } from 'util';

// Mock child_process.execFile before requiring the module
const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  execFile: mockExecFile,
}));

// Mock promisify to return our mock
jest.mock('util', () => ({
  promisify: jest.fn((fn: unknown) => {
    // Return a function that delegates to our mock
    return (...args: unknown[]) => mockExecFile(...args);
  }),
}));

describe('llm-client', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    // Re-apply mocks after resetModules
    jest.doMock('child_process', () => ({
      execFile: mockExecFile,
    }));
    jest.doMock('util', () => ({
      promisify: jest.fn(() => mockExecFile),
    }));
  });

  test('getActiveProvider returns "claude-cli"', () => {
    const { getActiveProvider } = require('../llm-client');
    expect(getActiveProvider()).toBe('claude-cli');
  });

  test('getActiveModel returns "claude (subscription)"', () => {
    const { getActiveModel } = require('../llm-client');
    expect(getActiveModel()).toBe('claude (subscription)');
  });

  test('chatComplete calls claude CLI with --print and returns trimmed stdout', async () => {
    mockExecFile.mockResolvedValue({ stdout: '  LLM response\n' });

    const { chatComplete } = require('../llm-client');
    const result = await chatComplete([{ role: 'user', content: 'hello' }]);

    expect(result).toBe('LLM response');
    expect(mockExecFile).toHaveBeenCalledWith(
      'claude',
      ['--print', 'hello'],
      expect.objectContaining({
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      })
    );
  });

  test('chatComplete concatenates multi-turn messages', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'response\n' });

    const { chatComplete } = require('../llm-client');
    await chatComplete([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow-up' },
    ]);

    // Multi-message format: user messages + [Previous response: ...] for assistant
    const callArgs = mockExecFile.mock.calls[0];
    const prompt = callArgs[1][1]; // second arg to ['--print', prompt]
    expect(prompt).toContain('first');
    expect(prompt).toContain('[Previous response: reply]');
    expect(prompt).toContain('follow-up');
  });

  test('chatComplete strips CLAUDECODE from env', async () => {
    process.env.CLAUDECODE = 'true';
    mockExecFile.mockResolvedValue({ stdout: 'ok\n' });

    const { chatComplete } = require('../llm-client');
    await chatComplete([{ role: 'user', content: 'test' }]);

    const callArgs = mockExecFile.mock.calls[0];
    const env = callArgs[2].env;
    expect(env.CLAUDECODE).toBeUndefined();

    delete process.env.CLAUDECODE;
  });
});
