/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';

const MCP_CHILD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  RORCA_API_URL: 'http://127.0.0.1:3030',
};

const FRIENDLY_ALIASES = [
  'rorca_get_context',
  'rorca_generate_spec',
  'rorca_create_spec',
  'rorca_persist_spec',
  'rorca_get_spec_export_kit',
  'rorca_get_spec_export_kit_artifact',
  'rorca_rebuild_spec_export_kit',
  'rorca_spec_workflow',
  'rorca_spec_readiness',
  'rorca_retry_spec_stage',
  'rorca_repair_spec',
  'rorca_repair_spec_batch',
  'rorca_list_specs',
  'rorca_approve_spec',
  'rorca_pipeline_status',
  'rorca_list_workspaces',
  'rorca_preflight_run',
  'rorca_trigger_run',
  'rorca_trigger_task_manifest',
  'rorca_run_status',
  'rorca_retry_story',
  'rorca_list_runs',
  'rorca_edit_story',
  'rorca_search_stories',
  'rorca_add_stories',
  'rorca_delete_story',
  'rorca_enrich_spec',
  'rorca_match_skills',
  'rorca_suggest_skills',
  'rorca_save_memory',
  'rorca_get_memories',
] as const;

async function waitForClose(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    proc.once('close', onClose);
  });
}

async function closeOnStdinEof(proc: ChildProcessWithoutNullStreams, stderr: string): Promise<void> {
  proc.stdin.end();
  if (!await waitForClose(proc, 1_000)) {
    throw new Error(`MCP test child did not exit naturally after stdin EOF: ${stderr}`);
  }
  proc.stdout.destroy();
  proc.stderr.destroy();
  if (proc.signalCode !== null) {
    throw new Error(`MCP test child was signal-terminated: ${proc.signalCode}; ${stderr}`);
  }
  if (proc.exitCode !== 0) {
    throw new Error(`MCP test child exited non-zero after stdin EOF: ${String(proc.exitCode)}; ${stderr}`);
  }
}

describe('MCP server integration', () => {
  it('lists every friendly alias without inherited DB authority and closes naturally on stdin EOF', async () => {
    expect(Object.keys(MCP_CHILD_ENV).sort()).toEqual(['NODE_ENV', 'RORCA_API_URL']);
    const proc = spawn(process.execPath, [
      '--import', 'tsx', path.resolve(__dirname, '../server.ts'),
    ], {
      cwd: path.resolve(__dirname, '../../..'),
      env: MCP_CHILD_ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const toolsResponse = await new Promise<any>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP tools response: ${stderr}`)), 10_000);
        const finish = (value: unknown, error?: Error) => {
          clearTimeout(timer);
          proc.off('error', onError);
          proc.off('exit', onExit);
          if (error) reject(error); else resolve(value);
        };
        const onError = (error: Error) => finish(undefined, error);
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          finish(undefined, new Error(`MCP child exited before tools response: code=${code} signal=${signal}; ${stderr}`));
        };
        proc.once('error', onError);
        proc.once('exit', onExit);
        proc.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          const response = output.split('\n').filter(Boolean)
            .map((line) => { try { return JSON.parse(line); } catch { return null; } })
            .find((message) => message?.id === 2);
          if (response) finish(response);
        });

        proc.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        })}\n`);
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
      });

      expect(toolsResponse).toBeTruthy();
      const toolNames = toolsResponse.result.tools.map((tool: { name: string }) => tool.name);
      expect(new Set(toolNames).size).toBe(toolNames.length);
      expect(toolNames).toEqual(expect.arrayContaining(FRIENDLY_ALIASES));
    } finally {
      await closeOnStdinEof(proc, stderr);
    }
  }, 20_000);
});
