import Anthropic from '@anthropic-ai/sdk';

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }

const PROVIDER = (process.env.SPEC_PROVIDER || 'anthropic') as 'anthropic' | 'openrouter';

async function chatCompleteAnthropic(messages: ChatMessage[], model?: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const m = model || process.env.SPEC_MODEL_ANTHROPIC || 'claude-sonnet-4-6';
  const response = await client.messages.create({
    model: m,
    max_tokens: 8096,
    messages,
  });
  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected non-text response from Anthropic');
  return block.text;
}

async function chatCompleteOpenRouter(messages: ChatMessage[], model?: string): Promise<string> {
  const m = model || process.env.SPEC_MODEL_OPENROUTER || 'openai/gpt-oss-120b';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({ model: m, messages }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}

export async function chatComplete(messages: ChatMessage[], model?: string): Promise<string> {
  if (PROVIDER === 'openrouter') return chatCompleteOpenRouter(messages, model);
  return chatCompleteAnthropic(messages, model);
}

export function getActiveProvider(): string { return PROVIDER; }
export function getActiveModel(): string {
  return PROVIDER === 'openrouter'
    ? (process.env.SPEC_MODEL_OPENROUTER || 'openai/gpt-oss-120b')
    : (process.env.SPEC_MODEL_ANTHROPIC || 'claude-sonnet-4-6');
}
