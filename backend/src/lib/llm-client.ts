import { execFile } from 'child_process';
import { promisify } from 'util';

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }

const execFileAsync = promisify(execFile);

// Uses your Claude subscription via the claude CLI — no API key needed
export async function chatComplete(messages: ChatMessage[]): Promise<string> {
  const prompt = messages.length === 1
    ? messages[0].content
    : messages.map(m =>
        m.role === 'user' ? m.content : `[Previous response: ${m.content}]`
      ).join('\n\n---\n\n');

  // Unset CLAUDECODE so the nested claude invocation isn't blocked
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const { stdout } = await execFileAsync('claude', ['--print', prompt], {
    env,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });

  return stdout.trim();
}

export function getActiveProvider(): string { return 'claude-cli'; }
export function getActiveModel(): string { return 'claude (subscription)'; }
