import { spawn } from 'child_process';

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  usage: TokenUsage;
}

// Supported model IDs — keep in sync with AC for US-003.
export const SUPPORTED_MODELS = [
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
] as const;

export type SupportedModel = typeof SUPPORTED_MODELS[number];

export const DEFAULT_MODEL: SupportedModel = 'claude-sonnet-4-5-20250929';

export function isValidModel(model: string): model is SupportedModel {
  return (SUPPORTED_MODELS as readonly string[]).includes(model);
}

// Resolve claude binary — NVM PATH not available in Node child processes.
// Override via CLAUDE_BIN env var for portability across machines.
const CLAUDE_BIN = process.env.CLAUDE_BIN ||
  '/Users/dimitriteravanessian/.nvm/versions/node/v20.19.6/bin/claude';

// All Claude Code env vars that block nested invocation.
const CLAUDE_ENV_VARS_TO_REMOVE = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

/**
 * Call the Claude CLI with an optional model override.
 * Uses --output-format json to capture token usage alongside the response text.
 */
export function chatComplete(messages: ChatMessage[], model?: SupportedModel): Promise<ChatResult> {
  const prompt = messages.length === 1
    ? messages[0].content
    : messages.map(m =>
        m.role === 'user' ? m.content : `[Previous response: ${m.content}]`
      ).join('\n\n---\n\n');

  // Build clean env — delete all Claude Code vars so the subprocess isn't blocked.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)) {
      env[k] = v;
    }
  }

  return new Promise((resolve, reject) => {
    const args = [
      '--dangerously-skip-permissions',
      '--print',
      '--output-format', 'json',
    ];
    if (model) {
      args.push('--model', model);
    }
    args.push(prompt);

    const child = spawn(CLAUDE_BIN, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on('close', (code) => {
      if (stderr) console.warn('[LLM] claude stderr:', stderr.slice(0, 500));
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}. stderr: ${stderr.slice(0, 300)}`));
        return;
      }
      if (!stdout.trim()) {
        reject(new Error(`claude returned empty output. stderr: ${stderr.slice(0, 300)}`));
        return;
      }

      // Parse JSON output to extract text and usage
      try {
        const parsed = JSON.parse(stdout.trim());
        const text = parsed.result ?? parsed.text ?? stdout.trim();
        const usage: TokenUsage = {
          inputTokens: parsed.input_tokens ?? parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.output_tokens ?? parsed.usage?.output_tokens ?? 0,
        };
        resolve({ text: typeof text === 'string' ? text : JSON.stringify(text), usage });
      } catch {
        // Fallback: treat entire stdout as plain text (no usage data available)
        resolve({ text: stdout.trim(), usage: { inputTokens: 0, outputTokens: 0 } });
      }
    });
  });
}

export function getActiveProvider(): string { return 'claude-cli'; }
export function getActiveModel(): string { return 'claude (subscription)'; }
