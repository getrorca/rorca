import { spawn } from 'child_process';

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }

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

export function chatComplete(messages: ChatMessage[]): Promise<string> {
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
    // Use spawn (not exec/shell) so the prompt is passed as a raw argv string —
    // no shell escaping, no special-character issues with $() or backticks.
    // --dangerously-skip-permissions: required for non-interactive mode.
    // stdio['ignore',...]: equivalent to < /dev/null, prevents TTY issues.
    const child = spawn(CLAUDE_BIN, [
      '--dangerously-skip-permissions',
      '--print',
      prompt,
    ], {
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
      resolve(stdout.trim());
    });
  });
}

export function getActiveProvider(): string { return 'claude-cli'; }
export function getActiveModel(): string { return 'claude (subscription)'; }
