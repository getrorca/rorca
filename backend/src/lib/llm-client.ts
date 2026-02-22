import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }

const execAsync = promisify(exec);

// Uses your Claude subscription via the claude CLI.
// Writes prompt to a temp file and uses shell expansion — required because
// claude --print produces empty output when spawned without a TTY.
export async function chatComplete(messages: ChatMessage[]): Promise<string> {
  const prompt = messages.length === 1
    ? messages[0].content
    : messages.map(m =>
        m.role === 'user' ? m.content : `[Previous response: ${m.content}]`
      ).join('\n\n---\n\n');

  // Write prompt to temp file (avoids shell injection and TTY issues)
  const tmpFile = path.join(os.tmpdir(), `rorcha-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt, 'utf8');

  try {
    // env -u CLAUDECODE: unset so nested invocation isn't blocked
    // < /dev/null: signal non-interactive mode (prevents SIGTTOU when backend runs in bg)
    const { stdout } = await execAsync(
      `env -u CLAUDECODE claude --print "$(cat ${tmpFile})" < /dev/null`,
      {
        shell: '/bin/bash',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 180_000,
      }
    );

    return stdout.trim();
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

export function getActiveProvider(): string { return 'claude-cli'; }
export function getActiveModel(): string { return 'claude (subscription)'; }
