describe('llm-client', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.SPEC_PROVIDER;
    delete process.env.SPEC_MODEL_ANTHROPIC;
    delete process.env.SPEC_MODEL_OPENROUTER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('getActiveProvider returns "anthropic" when SPEC_PROVIDER not set', () => {
    const { getActiveProvider } = require('../llm-client');
    expect(getActiveProvider()).toBe('anthropic');
  });

  test('getActiveProvider returns "openrouter" when SPEC_PROVIDER=openrouter', () => {
    process.env.SPEC_PROVIDER = 'openrouter';
    const { getActiveProvider } = require('../llm-client');
    expect(getActiveProvider()).toBe('openrouter');
  });

  test('getActiveModel returns "claude-sonnet-4-6" when SPEC_PROVIDER=anthropic and no model env', () => {
    const { getActiveModel } = require('../llm-client');
    expect(getActiveModel()).toBe('claude-sonnet-4-6');
  });

  test('getActiveModel returns "openai/gpt-oss-120b" when SPEC_PROVIDER=openrouter and no model env', () => {
    process.env.SPEC_PROVIDER = 'openrouter';
    const { getActiveModel } = require('../llm-client');
    expect(getActiveModel()).toBe('openai/gpt-oss-120b');
  });

  test('chatComplete with provider=anthropic calls Anthropic SDK', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const mockCreate = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'LLM response' }],
    });

    jest.doMock('@anthropic-ai/sdk', () => {
      return {
        __esModule: true,
        default: jest.fn().mockImplementation(() => ({
          messages: { create: mockCreate },
        })),
      };
    });

    const { chatComplete } = require('../llm-client');
    const result = await chatComplete([{ role: 'user', content: 'hello' }]);

    expect(result).toBe('LLM response');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
      })
    );
  });

  test('chatComplete with provider=openrouter calls OpenRouter fetch', async () => {
    process.env.SPEC_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-or-key';

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'OR response' } }],
      }),
    });
    global.fetch = mockFetch;

    const { chatComplete } = require('../llm-client');
    const result = await chatComplete([{ role: 'user', content: 'hello' }]);

    expect(result).toBe('OR response');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-or-key',
        }),
      })
    );
  });
});
