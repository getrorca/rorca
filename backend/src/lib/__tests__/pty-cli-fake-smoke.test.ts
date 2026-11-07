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

const mockPrepareAutonomousSandboxLaunch = jest.fn((options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => ({ ...options, isolated: true }));

jest.mock('../autonomous-sandbox', () => ({
  prepareAutonomousSandboxLaunch: (options: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) => mockPrepareAutonomousSandboxLaunch(options),
}));

import { buildPtyCompletionMarker, buildPtyMarkerFilePath, createBaseInteractivePtyAdapter, createPtyCompletionState } from '../interactive-pty-agent-adapter';
import {
  buildPtyCommand,
  isHostBoundCompletionStatusValid,
  stageHostBoundCompletionStatus,
} from '../execution-engine';
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
    const preparedMarkerFile = process.env.RORCA_SMOKE_PREPARED_MARKER_FILE;
    fs.renameSync(preparedMarkerFile, markerFile);
    console.log('KEYBOARD_RECEIVED');
    setTimeout(() => console.log(marker), 20);
  }
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return cliPath;
}

function envKey(agent: AgentType): string {
  return { claude: 'CLAUDE_BIN', opencode: 'OPENCODE_BIN', codex: 'CODEX_BIN', pi: 'PI_BIN', omp: 'OMP_BIN' }[agent]!;
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
    const versionProbe = mockPrepareAutonomousSandboxLaunch.mock.calls
      .map(([launch]) => launch)
      .find((launch) => launch.args.length === 1 && launch.args[0] === '--version');
    expect(versionProbe).toBeDefined();
    expect(versionProbe?.command).toBe(fs.realpathSync(fakeCli));
    expect(versionProbe?.args).toEqual(['--version']);
  });

  it('makes Codex PTY approval noninteractive so unattended runs cannot stall', () => {
    const compatibility = probePtyCliCompatibility('codex', {
      force: true,
      env: { ...process.env, CODEX_BIN: fakeCli },
    });
    const command = buildPtyCommand(
      'codex', 'prompt', tempDir, 'gpt-test', null,
      undefined, undefined, undefined, undefined, [], compatibility,
    );
    expect(command.args).toContain('--ask-for-approval');
    expect(command.args[command.args.indexOf('--ask-for-approval') + 1]).toBe('never');
    expect(command.args).not.toContain('on-request');
  });

  for (const agentType of ['claude', 'opencode', 'codex', 'pi', 'omp'] as AgentType[]) {
    it(`${agentType}: live/reconnect, resize, input, completion file, cancellation, and process-group cleanup`, async () => {
      const compatibility = probePtyCliCompatibility(agentType, {
        force: true,
        env: { ...process.env, [envKey(agentType)]: fakeCli },
      });
      expect(compatibility.ready).toBe(true);

      const runId = 700 + ['claude', 'opencode', 'codex', 'pi', 'omp'].indexOf(agentType);
      const storyId = `SMOKE-${agentType}`;
      const marker = buildPtyCompletionMarker(runId, storyId);
      const markerFile = path.join(tempDir, buildPtyMarkerFilePath(runId, storyId));
      const completionBinding = {
        markerFile,
        runId,
        completionMarker: marker,
        generationRef: {
          runId,
          generationId: '11111111-1111-4111-8111-111111111111',
          generationToken: '22222222-2222-4222-8222-222222222222',
        },
        storyId,
        attempt: 1,
      };
      const preparedMarkerFile = stageHostBoundCompletionStatus(completionBinding);
      const adapter = createBaseInteractivePtyAdapter(agentType, (input) => buildPtyCommand(
        input.agentType, input.prompt, input.cwd, null, null,
        undefined, undefined, undefined, undefined, [], compatibility,
      ));
      const prompt = adapter.preparePrompt({
        basePrompt: `Fake ${agentType} PTY smoke.`,
        runId,
        storyId,
        agentType,
        completionMarker: marker,
        markerFilePath: markerFile,
        preparedMarkerFilePath: preparedMarkerFile,
        generationId: completionBinding.generationRef.generationId,
        generationToken: completionBinding.generationRef.generationToken,
        attempt: completionBinding.attempt,
      });
      const command = adapter.resolveCommand({ agentType, prompt, cwd: tempDir, runId, storyId });
      const pty = nodePty.spawn(command.command, command.args, {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: tempDir,
        env: {
          ...command.env,
          RORCA_SMOKE_MARKER: marker,
          RORCA_SMOKE_MARKER_FILE: markerFile,
          RORCA_SMOKE_PREPARED_MARKER_FILE: preparedMarkerFile,
        },
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
        expect(isHostBoundCompletionStatusValid(completionBinding)).toBe(true);
        expect(fs.existsSync(preparedMarkerFile)).toBe(false);
      } finally {
        await shutdownPtyProcess(pty, { graceMs: 500, postKillSettleMs: 100, waitForExit: exitObserved });
        command.cleanup?.();
      }

      await waitFor(() => !processAlive(childPid), 3_000);
      expect(processAlive(childPid)).toBe(false);
    }, 15_000);
  }
});
