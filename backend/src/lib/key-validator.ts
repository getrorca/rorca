import { createHash } from 'crypto';

export interface ProviderKeyValidationResult {
  valid: boolean;
  error?: string;
}

type SupportedProvider = 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'openai-compat';

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const validationCache = new Map<string, { expiresAt: number; result: ProviderKeyValidationResult }>();

function normalizeProvider(provider: string): SupportedProvider | null {
  switch (provider) {
    case 'anthropic':
    case 'openai':
    case 'openrouter':
    case 'ollama':
    case 'openai-compat':
      return provider;
    default:
      return null;
  }
}

function hashKey(provider: string, apiKey: string): string {
  return createHash('sha256').update(`${provider}:${apiKey}`).digest('hex');
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function validateAnthropic(apiKey: string): Promise<ProviderKeyValidationResult> {
  try {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        max_tokens: 1,
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: 'Anthropic API key was rejected' };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'Anthropic validation failed' };
  }
}

async function validateOpenAI(apiKey: string): Promise<ProviderKeyValidationResult> {
  try {
    const response = await fetchWithTimeout('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (response.status === 401) {
      return { valid: false, error: 'OpenAI API key was rejected' };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'OpenAI validation failed' };
  }
}

async function validateOpenRouter(apiKey: string): Promise<ProviderKeyValidationResult> {
  try {
    const response = await fetchWithTimeout('https://openrouter.ai/api/v1/auth/key', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response.ok) {
      return { valid: false, error: 'OpenRouter API key was rejected' };
    }
    const payload = await response.json() as { data?: { usage?: unknown } };
    return payload?.data && 'usage' in payload.data
      ? { valid: true }
      : { valid: false, error: 'OpenRouter validation response was invalid' };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'OpenRouter validation failed' };
  }
}

async function validateOllama(): Promise<ProviderKeyValidationResult> {
  try {
    const response = await fetchWithTimeout('http://localhost:11434/api/tags', { method: 'GET' });
    return response.status === 200
      ? { valid: true }
      : { valid: false, error: 'Ollama is not responding on localhost:11434' };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'Ollama validation failed' };
  }
}

export async function validateProviderKey(provider: string, apiKey: string): Promise<ProviderKeyValidationResult> {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) {
    return { valid: true };
  }

  if (normalizedProvider === 'ollama') {
    return validateOllama();
  }

  const cacheKey = hashKey(normalizedProvider, apiKey);
  const cached = validationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const result = normalizedProvider === 'anthropic'
    ? await validateAnthropic(apiKey)
    : normalizedProvider === 'openrouter'
      ? await validateOpenRouter(apiKey)
      : await validateOpenAI(apiKey);

  validationCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, result });
  return result;
}

