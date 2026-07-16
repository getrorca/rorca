/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Deterministic interactive PTY smoke harness. It runs a harmless local fake
 * CLI through each production command adapter; no network/auth/real CLI use.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPtyCompletionMarker, buildPtyMarkerFilePath, createBaseInteractivePtyAdapter, createPtyCompletionState } from '../interactive-pty-agent-adapter';
import { buildPtyCommand } from '../execution-engine';
import { probePtyCliCompatibility } from '../pty-cli-compat';
import { shutdownPtyProcess } from '../pty-manager';
import type { AgentType } from '../config';

const nodePty = require('node-pty') as typeof import('node-pty');

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for fake PTY output`));
      }
    }, 10);
  });
}

function writeFakeCli(directory: string): string {
  const cliPath = path.join(directory, 'fake-pty-cli.js');
  fs.writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const flags = '--dangerously-skip-permissions --permission-mode --model --thinking-budget --effort --mcp-config opencode attach <url> --ask-for-approval --no-alt-screen --mode --no-extensions --tools --append-system-prompt --extension --provider --thinking --skill';
if (process.argv.includes('--version')) { console.log('fake-pty-cli 9.9.9'); process.exit(0); }
if (process.argv.includes('--help')) { console.log(flags); process.exit(0); }
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log('LIVE_READY child=' + child.pid);
process.on('SIGWINCH', () => console.log('RESIZE_RECEIVED'));
let receivedPrompt = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  if (!receivedPrompt && data.includes('Rorca PTY Completion Contract')) {
    receivedPrompt = true;
    console.log('LIVE_PROMPT_RECEIVED');
    return;
  }
  if (receivedPrompt && data.includes('keyboard-contract')) {
    const marker = process.env.RORCA_SMOKE_MARKER;
    const markerFile = process.env.RORCA_SMOKE_MARKER_FILE;
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ marker }));
    console.log('KEYBOARD_RECEIVED');
    setTimeout(() => console.log(marker), 20);
  }
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return cliPath;
}

function envKey(agent: AgentType): string {
  return { claude: 'CLAUDE_BIN', opencode: 'OPENCODE_BIN', codex: 'CODEX_BIN', pi: 'PI_BIN' }[agent];
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('deterministic fake-CLI PTY adapter smoke harness', () => {
  let tempDir: string;
  let fakeCli: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pty-fake-smoke-'));
    fakeCli = writeFakeCli(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses the official OpenCode attach subcommand instead of the rejected --attach flag', () => {
    const compatibility = probePtyCliCompatibility('opencode', {
      force: true,
      env: { ...process.env, OPENCODE_BIN: fakeCli },
    });
    const command = buildPtyCommand(
      'opencode', 'prompt', tempDir, null, 'http://127.0.0.1:4096',
      undefined, undefined, undefined, undefined, [], compatibility,
    );
    expect(command.args).toEqual(['attach', 'http://127.0.0.1:4096']);
    expect(command.args).not.toContain('--attach');
  });

  for (const agentType of ['claude', 'opencode', 'codex', 'pi'] as AgentType[]) {
    it(`${agentType}: live/reconnect, resize, input, completion file, cancellation, and process-group cleanup`, async () => {
      const compatibility = probePtyCliCompatibility(agentType, {
        force: true,
        env: { ...process.env, [envKey(agentType)]: fakeCli },
      });
      expect(compatibility.ready).toBe(true);

      const runId = 700 + ['claude', 'opencode', 'codex', 'pi'].indexOf(agentType);
      const storyId = `SMOKE-${agentType}`;
      const marker = buildPtyCompletionMarker(runId, storyId);
      const markerFile = path.join(tempDir, buildPtyMarkerFilePath(runId, storyId));
      const adapter = createBaseInteractivePtyAdapter(agentType, (input) => buildPtyCommand(
        input.agentType, input.prompt, input.cwd, null, null,
        undefined, undefined, undefined, undefined, [], compatibility,
      ));
      const prompt = adapter.preparePrompt({
        basePrompt: `Fake ${agentType} PTY smoke.`, runId, storyId, agentType, completionMarker: marker,
        markerFilePath: buildPtyMarkerFilePath(runId, storyId),
      });
      const command = adapter.resolveCommand({ agentType, prompt, cwd: tempDir, runId, storyId });
      const pty = nodePty.spawn(command.command, command.args, {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: tempDir,
        env: { ...command.env, RORCA_SMOKE_MARKER: marker, RORCA_SMOKE_MARKER_FILE: markerFile },
        encoding: 'utf8',
      });
      const firstConnection: string[] = [];
      const firstSubscription = pty.onData((chunk) => firstConnection.push(chunk));
      const exitObserved = new Promise<void>((resolve) => pty.onExit(() => resolve()));
      let childPid = 0;

      try {
        await waitFor(() => firstConnection.join('').includes('LIVE_READY'));
        childPid = Number(firstConnection.join('').match(/child=(\d+)/)?.[1] ?? 0);
        expect(childPid).toBeGreaterThan(0);

        await adapter.injectPrompt(pty, prompt);
        await waitFor(() => firstConnection.join('').includes('LIVE_PROMPT_RECEIVED'));
        // Simulate a browser reconnect: future terminal bytes must remain live.
        firstSubscription.dispose();
        const reconnected: string[] = [];
        const secondSubscription = pty.onData((chunk) => reconnected.push(chunk));
        try {
          pty.resize(101, 39);
          await waitFor(() => reconnected.join('').includes('RESIZE_RECEIVED'));
          pty.write('keyboard-contract\r');
          await waitFor(() => reconnected.join('').includes('KEYBOARD_RECEIVED') && reconnected.join('').includes(marker));
        } finally {
          secondSubscription.dispose();
        }

        const completion = createPtyCompletionState(marker);
        expect(adapter.detectCompletion?.(reconnected.join(''), completion)).toEqual({ type: 'marker', marker });
        expect(JSON.parse(fs.readFileSync(markerFile, 'utf8'))).toMatchObject({ marker });
      } finally {
        await shutdownPtyProcess(pty, { graceMs: 500, postKillSettleMs: 100, waitForExit: exitObserved });
        command.cleanup?.();
      }

      await waitFor(() => !processAlive(childPid), 3_000);
      expect(processAlive(childPid)).toBe(false);
    }, 15_000);
  }
});
