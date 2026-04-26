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

// Mock Anthropic SDK
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  }));
});

// Mock OpenAI SDK
const mockOpenAICreate = jest.fn();
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockOpenAICreate } },
  }));
});

// Mock logger so we can spy on warn calls in tests
const mockLoggerWarn = jest.fn();
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: mockLoggerWarn,
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('llm-client', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.doMock('child_process', () => ({ spawn: mockSpawn }));
    jest.doMock('@anthropic-ai/sdk', () => {
      return jest.fn().mockImplementation(() => ({
        messages: { create: mockAnthropicCreate },
      }));
    });
    jest.doMock('openai', () => {
      return jest.fn().mockImplementation(() => ({
        chat: { completions: { create: mockOpenAICreate } },
      }));
    });
    jest.doMock('../logger', () => ({
      logger: {
        info: jest.fn(),
        warn: mockLoggerWarn,
        error: jest.fn(),
        debug: jest.fn(),
      },
    }));
  });

  // ── Existing tests (backward compat) ──────────────────────────────────────

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
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 200, reasoningTokens: 0 });
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
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
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

  test('isValidModel validates all registered models', () => {
    const { isValidModel } = require('../llm-client');
    // Anthropic models
    expect(isValidModel('claude-sonnet-4-6')).toBe(true);
    expect(isValidModel('claude-opus-4-6')).toBe(true);
    expect(isValidModel('claude-haiku-4-5-20251001')).toBe(true);
    // OpenAI-compat models
    expect(isValidModel('gpt-4o')).toBe(true);
    expect(isValidModel('gpt-4o-mini')).toBe(true);
    expect(isValidModel('deepseek-chat')).toBe(true);
    // OpenRouter models
    expect(isValidModel('google/gemini-2.5-pro-preview')).toBe(true);
    expect(isValidModel('x-ai/grok-3')).toBe(true);
    // Invalid
    expect(isValidModel('nonexistent-model')).toBe(false);
    expect(isValidModel('')).toBe(false);
  });

  test('SUPPORTED_MODELS contains Anthropic models (backward compat)', () => {
    const { SUPPORTED_MODELS } = require('../llm-client');
    expect(SUPPORTED_MODELS).toHaveLength(4);
    expect(SUPPORTED_MODELS).toContain('claude-sonnet-4-6');
    expect(SUPPORTED_MODELS).toContain('claude-opus-4-6');
    expect(SUPPORTED_MODELS).toContain('claude-opus-4-7');
    expect(SUPPORTED_MODELS).toContain('claude-haiku-4-5-20251001');
  });

  // ── Provider routing tests ────────────────────────────────────────────────

  describe('provider routing', () => {
    test('defaults to claude-cli when no provider or apiKey', async () => {
      const jsonOutput = JSON.stringify({ result: 'ok', input_tokens: 1, output_tokens: 1 });
      mockSpawn.mockReturnValue(fakeChild(jsonOutput, '', 0));

      const { chatComplete } = require('../llm-client');
      await chatComplete([{ role: 'user', content: 'test' }]);

      expect(mockSpawn).toHaveBeenCalled();
      expect(mockAnthropicCreate).not.toHaveBeenCalled();
      expect(mockOpenAICreate).not.toHaveBeenCalled();
    });

    test('routes to anthropic SDK when provider is "anthropic"', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'anthropic response' }],
        usage: { input_tokens: 50, output_tokens: 100 },
      });

      const { chatComplete } = require('../llm-client');
      const result = await chatComplete(
        [{ role: 'user', content: 'test' }],
        { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-opus-4-6' },
      );

      expect(result.text).toBe('anthropic response');
      expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 100, reasoningTokens: 0 });
      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-4-6', max_tokens: 16384 }),
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    test('routes to anthropic when apiKey provided without explicit provider (backward compat)', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'response' }],
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        { apiKey: 'sk-ant-test' },
      );

      expect(mockAnthropicCreate).toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    test('routes to openai-compat when provider is "openai-compat"', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'openai response' } }],
        usage: { prompt_tokens: 30, completion_tokens: 60 },
      });

      const { chatComplete } = require('../llm-client');
      const result = await chatComplete(
        [{ role: 'user', content: 'test' }],
        { provider: 'openai-compat', apiKey: 'sk-test', model: 'gpt-4o' },
      );

      expect(result.text).toBe('openai response');
      expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 60, reasoningTokens: 0 });
      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o', max_tokens: 16384 }),
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    test('routes to openrouter when provider is "openrouter"', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'openrouter response' } }],
        usage: { prompt_tokens: 25, completion_tokens: 50 },
      });

      const { chatComplete } = require('../llm-client');
      const result = await chatComplete(
        [{ role: 'user', content: 'test' }],
        { provider: 'openrouter', apiKey: 'sk-or-test', model: 'google/gemini-2.5-pro-preview' },
      );

      expect(result.text).toBe('openrouter response');
      expect(result.usage).toEqual({ inputTokens: 25, outputTokens: 50, reasoningTokens: 0 });
      expect(mockOpenAICreate).toHaveBeenCalled();
    });

    test('infers provider from model registry when no explicit provider', async () => {
      // gpt-4o is registered as openai-compat in ALL_MODELS
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'inferred' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        { model: 'gpt-4o', apiKey: 'sk-test' },
      );

      expect(mockOpenAICreate).toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    test('infers openrouter from model registry for google/gemini models', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'gemini' } }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        { model: 'google/gemini-2.5-flash-preview', apiKey: 'sk-or-test' },
      );

      expect(mockOpenAICreate).toHaveBeenCalled();
    });

    test('uses claude-cli for Anthropic models when no apiKey', async () => {
      const jsonOutput = JSON.stringify({ result: 'cli', input_tokens: 1, output_tokens: 1 });
      mockSpawn.mockReturnValue(fakeChild(jsonOutput, '', 0));

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        { model: 'claude-opus-4-6' },
      );

      expect(mockSpawn).toHaveBeenCalled();
      expect(mockAnthropicCreate).not.toHaveBeenCalled();
    });

    test('throws when anthropic provider has no apiKey', async () => {
      const { chatComplete } = require('../llm-client');
      await expect(chatComplete(
        [{ role: 'user', content: 'test' }],
        { provider: 'anthropic' },
      )).rejects.toThrow('Anthropic provider requires an API key');
    });

    test('throws when openai-compat provider has no apiKey', async () => {
      const { chatComplete } = require('../llm-client');
      await expect(chatComplete(
        [{ role: 'user', content: 'test' }],
        { provider: 'openai-compat', model: 'gpt-4o' },
      )).rejects.toThrow('OpenAI-compatible provider requires an API key');
    });

    test('throws when openrouter provider has no apiKey', async () => {
      const { chatComplete } = require('../llm-client');
      await expect(chatComplete(
        [{ role: 'user', content: 'test' }],
        { provider: 'openrouter', model: 'google/gemini-2.5-pro-preview' },
      )).rejects.toThrow('OpenRouter provider requires an API key');
    });

    test('normalizes openai-compat usage to { inputTokens, outputTokens }', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'response' } }],
        usage: { prompt_tokens: 42, completion_tokens: 84 },
      });

      const { chatComplete } = require('../llm-client');
      const result = await chatComplete(
        [{ role: 'user', content: 'test' }],
        { provider: 'openai-compat', apiKey: 'sk-test', model: 'gpt-4o' },
      );

      expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 84, reasoningTokens: 0 });
    });

    test('handles missing usage from openai-compat gracefully', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'no usage' } }],
        // some providers may not return usage
      });

      const { chatComplete } = require('../llm-client');
      const result = await chatComplete(
        [{ role: 'user', content: 'test' }],
        { provider: 'openai-compat', apiKey: 'sk-test', model: 'gpt-4o' },
      );

      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
    });
  });

  // ── Reasoning options tests ───────────────────────────────────────────────

  describe('reasoning options', () => {
    // ── Anthropic ──

    test('anthropic: reasoning.enabled maps to thinking block with effort-derived budget', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'response with thinking' }],
        usage: { input_tokens: 50, output_tokens: 100 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'solve this' }],
        {
          provider: 'anthropic',
          apiKey: 'sk-ant-test',
          model: 'claude-opus-4-6',
          reasoning: { enabled: true, effort: 'medium' },
        },
      );

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: 'enabled', budget_tokens: 16384 },
        }),
      );
    });

    test('anthropic: reasoning.effort low maps to 4096 budget_tokens', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'low effort response' }],
        usage: { input_tokens: 20, output_tokens: 40 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'quick question' }],
        {
          provider: 'anthropic',
          apiKey: 'sk-ant-test',
          model: 'claude-sonnet-4-6',
          reasoning: { enabled: true, effort: 'low' },
        },
      );

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: 'enabled', budget_tokens: 4096 },
        }),
      );
    });

    test('anthropic: reasoning.budgetTokens explicit overrides effort mapping', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'custom budget' }],
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        {
          provider: 'anthropic',
          apiKey: 'sk-ant-test',
          model: 'claude-opus-4-6',
          reasoning: { enabled: true, effort: 'low', budgetTokens: 8000 },
        },
      );

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: 'enabled', budget_tokens: 8000 },
        }),
      );
    });

    test('anthropic: reasoning.enabled=false sends no thinking block', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'no thinking' }],
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        {
          provider: 'anthropic',
          apiKey: 'sk-ant-test',
          model: 'claude-opus-4-6',
          reasoning: { enabled: false },
        },
      );

      const call = mockAnthropicCreate.mock.calls[0][0];
      expect(call.thinking).toBeUndefined();
    });

    test('anthropic: no reasoning field sends no thinking block', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'plain response' }],
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-opus-4-6' },
      );

      const call = mockAnthropicCreate.mock.calls[0][0];
      expect(call.thinking).toBeUndefined();
    });

    test('anthropic: max_tokens auto-adjusted when budget_tokens would exceed it', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'big thinking' }],
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        {
          provider: 'anthropic',
          apiKey: 'sk-ant-test',
          model: 'claude-opus-4-6',
          reasoning: { enabled: true, effort: 'high' }, // maps to 32768
          maxTokens: 1000, // less than budget_tokens
        },
      );

      const call = mockAnthropicCreate.mock.calls[0][0];
      // max_tokens must be > budget_tokens (32768), so it gets bumped to 32768 + 16384
      expect(call.max_tokens).toBeGreaterThan(32768);
    });

    // ── OpenAI-compat ──

    test('openai-compat: reasoning.effort on o-series model injects reasoning_effort', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'o3 response' } }],
        usage: { prompt_tokens: 30, completion_tokens: 60 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'complex reasoning task' }],
        {
          provider: 'openai-compat',
          apiKey: 'sk-test',
          model: 'o3',
          reasoning: { enabled: true, effort: 'high' },
        },
      );

      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ reasoning_effort: 'high' }),
      );
    });

    test('openai-compat: reasoning on non-o-series model does NOT inject reasoning_effort', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'gpt-4o response' } }],
        usage: { prompt_tokens: 30, completion_tokens: 60 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        {
          provider: 'openai-compat',
          apiKey: 'sk-test',
          model: 'gpt-4o',
          reasoning: { enabled: true, effort: 'high' },
        },
      );

      const call = mockOpenAICreate.mock.calls[0][0];
      expect(call.reasoning_effort).toBeUndefined();
    });

    test('openai-compat: reasoning.enabled=false on o-series does NOT inject reasoning_effort', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        {
          provider: 'openai-compat',
          apiKey: 'sk-test',
          model: 'o3',
          reasoning: { enabled: false, effort: 'high' },
        },
      );

      const call = mockOpenAICreate.mock.calls[0][0];
      expect(call.reasoning_effort).toBeUndefined();
    });

    // ── OpenRouter ──

    test('openrouter: reasoning.enabled maps to reasoning: { effort } param', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'openrouter reasoning response' } }],
        usage: { prompt_tokens: 40, completion_tokens: 80 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'think hard' }],
        {
          provider: 'openrouter',
          apiKey: 'sk-or-test',
          model: 'x-ai/grok-3',
          reasoning: { enabled: true, effort: 'medium' },
        },
      );

      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ reasoning: { effort: 'medium' } }),
      );
    });

    test('openrouter: reasoning.enabled=false sends no reasoning param', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'no reasoning' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        {
          provider: 'openrouter',
          apiKey: 'sk-or-test',
          model: 'x-ai/grok-3',
          reasoning: { enabled: false, effort: 'high' },
        },
      );

      const call = mockOpenAICreate.mock.calls[0][0];
      expect(call.reasoning).toBeUndefined();
    });

    test('openrouter: no reasoning field sends no reasoning param', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'plain' } }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        {
          provider: 'openrouter',
          apiKey: 'sk-or-test',
          model: 'google/gemini-2.5-pro-preview',
        },
      );

      const call = mockOpenAICreate.mock.calls[0][0];
      expect(call.reasoning).toBeUndefined();
    });

    test('openrouter: GLM-5 no longer gets hardcoded reasoning (must be explicitly requested)', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'glm response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });

      const { chatComplete } = require('../llm-client');
      // No reasoning field — GLM-5 should NOT auto-inject reasoning anymore
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        {
          provider: 'openrouter',
          apiKey: 'sk-or-test',
          model: 'z-ai/glm-5',
        },
      );

      const call = mockOpenAICreate.mock.calls[0][0];
      expect(call.reasoning).toBeUndefined();
    });
  });

  // ── Model registry tests ──────────────────────────────────────────────────

  describe('model registry', () => {
    test('ALL_MODELS contains models from all providers', () => {
      const { ALL_MODELS } = require('../llm-client');
      const providerTypes = [...new Set(ALL_MODELS.map((m: any) => m.providerType))];
      expect(providerTypes).toContain('anthropic');
      expect(providerTypes).toContain('openai-compat');
      expect(providerTypes).toContain('openrouter');
    });

    test('getModelInfo returns correct info', () => {
      const { getModelInfo } = require('../llm-client');
      const info = getModelInfo('gpt-4o');
      expect(info).toBeDefined();
      expect(info.providerType).toBe('openai-compat');
      expect(info.provider).toBe('OpenAI');
    });

    test('getModelInfo returns undefined for unknown model', () => {
      const { getModelInfo } = require('../llm-client');
      expect(getModelInfo('nonexistent')).toBeUndefined();
    });

    test('getModelsForProviders filters correctly', () => {
      const { getModelsForProviders } = require('../llm-client');

      // Only claude-cli should return Anthropic models
      const cliModels = getModelsForProviders(['claude-cli']);
      expect(cliModels.length).toBeGreaterThan(0);
      expect(cliModels.every((m: any) => m.providerType === 'anthropic')).toBe(true);

      // openai-compat should return openai-compat models
      const oaiModels = getModelsForProviders(['openai-compat']);
      expect(oaiModels.every((m: any) => m.providerType === 'openai-compat')).toBe(true);

      // Multiple providers
      const multi = getModelsForProviders(['claude-cli', 'openrouter']);
      const types = [...new Set(multi.map((m: any) => m.providerType))];
      expect(types).toContain('anthropic'); // claude-cli maps to anthropic models
      expect(types).toContain('openrouter');
    });

    test('MODEL_INFO backward compat contains Anthropic models', () => {
      const { MODEL_INFO } = require('../llm-client');
      expect(MODEL_INFO['claude-sonnet-4-6']).toBeDefined();
      expect(MODEL_INFO['claude-opus-4-6']).toBeDefined();
      expect(MODEL_INFO['claude-opus-4-7']).toBeDefined();
      expect(MODEL_INFO['claude-haiku-4-5-20251001']).toBeDefined();
    });
  });

  // ── Reasoning fallback / capability cache tests ───────────────────────────

  describe('reasoning fallback and capability cache', () => {
    beforeEach(() => {
      // Reset module registry so the in-memory cache is fresh for each test.
      jest.resetModules();
      jest.clearAllMocks();
      jest.doMock('child_process', () => ({ spawn: mockSpawn }));
      jest.doMock('@anthropic-ai/sdk', () => {
        return jest.fn().mockImplementation(() => ({
          messages: { create: mockAnthropicCreate },
        }));
      });
      jest.doMock('openai', () => {
        return jest.fn().mockImplementation(() => ({
          chat: { completions: { create: mockOpenAICreate } },
        }));
      });
      // Re-register logger mock after resetModules so warn spy works inside llm-client.
      jest.doMock('../logger', () => ({
        logger: {
          info: jest.fn(),
          warn: mockLoggerWarn,
          error: jest.fn(),
          debug: jest.fn(),
        },
      }));
    });

    test('anthropic: retries without reasoning on reasoning-related error', async () => {
      // First call (with reasoning) throws a reasoning-related error.
      mockAnthropicCreate
        .mockRejectedValueOnce(new Error('thinking is not supported for this model'))
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'fallback response' }],
          usage: { input_tokens: 10, output_tokens: 20 },
        });

      const { chatComplete } = require('../llm-client');
      const result = await chatComplete(
        [{ role: 'user', content: 'test' }],
        {
          provider: 'anthropic',
          apiKey: 'sk-ant-test',
          model: 'claude-opus-4-6',
          reasoning: { enabled: true, effort: 'medium' },
        },
      );

      expect(result.text).toBe('fallback response');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);

      // Second call must NOT contain the thinking block.
      const secondCall = mockAnthropicCreate.mock.calls[1][0];
      expect(secondCall.thinking).toBeUndefined();
    });

    test('anthropic: retry logs structured warning with model, error, action', async () => {
      mockAnthropicCreate
        .mockRejectedValueOnce(new Error('reasoning is not enabled'))
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 10 },
        });

      const { chatComplete } = require('../llm-client');
      await chatComplete(
        [{ role: 'user', content: 'test' }],
        {
          provider: 'anthropic',
          apiKey: 'sk-ant-test',
          model: 'claude-sonnet-4-6',
          reasoning: { enabled: true, effort: 'low' },
        },
      );

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-6',
          action: 'retried_without_reasoning',
          error: expect.stringContaining('reasoning'),
        }),
      );
    });

    test('capability cache: subsequent call for same model skips reasoning without retrying', async () => {
      // First call fails with reasoning error.
      mockAnthropicCreate
        .mockRejectedValueOnce(new Error('thinking is not available'))
        .mockResolvedValue({
          content: [{ type: 'text', text: 'cached path response' }],
          usage: { input_tokens: 5, output_tokens: 10 },
        });

      const { chatComplete, isModelMarkedNonReasoning } = require('../llm-client');

      // First call — triggers retry and populates the cache.
      await chatComplete(
        [{ role: 'user', content: 'first' }],
        {
          provider: 'anthropic',
          apiKey: 'sk-ant-test',
          model: 'claude-opus-4-6',
          reasoning: { enabled: true, effort: 'high' },
        },
      );

      // Cache should now mark this model as non-reasoning.
      expect(isModelMarkedNonReasoning('claude-opus-4-6')).toBe(true);
      jest.clearAllMocks();

      // Second call — must not throw and must NOT include thinking block.
      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'second response' }],
        usage: { input_tokens: 5, output_tokens: 10 },
      });

      const result = await chatComplete(
        [{ role: 'user', content: 'second' }],
        {
          provider: 'anthropic',
          apiKey: 'sk-ant-test',
          model: 'claude-opus-4-6',
          reasoning: { enabled: true, effort: 'high' },
        },
      );

      // Only ONE call — no retry needed because cache already knows.
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
      const call = mockAnthropicCreate.mock.calls[0][0];
      expect(call.thinking).toBeUndefined();
      expect(result.text).toBe('second response');
    });

    test('openrouter: retries without reasoning on reasoning-related error', async () => {
      mockOpenAICreate
        .mockRejectedValueOnce(new Error('reasoning parameter is not supported'))
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'fallback openrouter' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        });

      const { chatComplete } = require('../llm-client');
      const result = await chatComplete(
        [{ role: 'user', content: 'test' }],
        {
          provider: 'openrouter',
          apiKey: 'sk-or-test',
          model: 'x-ai/grok-3',
          reasoning: { enabled: true, effort: 'medium' },
        },
      );

      expect(result.text).toBe('fallback openrouter');
      expect(mockOpenAICreate).toHaveBeenCalledTimes(2);

      // Second call must NOT include reasoning param.
      const secondCall = mockOpenAICreate.mock.calls[1][0];
      expect(secondCall.reasoning).toBeUndefined();
    });

    test('non-reasoning error is re-thrown and does not trigger retry', async () => {
      mockAnthropicCreate.mockRejectedValueOnce(new Error('network timeout'));

      const { chatComplete } = require('../llm-client');
      await expect(
        chatComplete(
          [{ role: 'user', content: 'test' }],
          {
            provider: 'anthropic',
            apiKey: 'sk-ant-test',
            model: 'claude-opus-4-6',
            reasoning: { enabled: true, effort: 'medium' },
          },
        ),
      ).rejects.toThrow('network timeout');

      // No retry — only one call.
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    });

    test('markModelAsNonReasoning and isModelMarkedNonReasoning are exported and work correctly', () => {
      const { markModelAsNonReasoning, isModelMarkedNonReasoning } = require('../llm-client');

      expect(isModelMarkedNonReasoning('some-model')).toBe(false);
      markModelAsNonReasoning('some-model');
      expect(isModelMarkedNonReasoning('some-model')).toBe(true);
    });
  });
});
