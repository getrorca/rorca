/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawn } from 'child_process';
import * as path from 'path';

describe('MCP server integration', () => {
  it('lists the core friendly spec/pipeline aliases', (done) => {
    const proc = spawn('npx', ['tsx', path.resolve(__dirname, '../server.ts')], {
      env: { ...process.env, NODE_ENV: 'production', RORCA_API_URL: 'http://localhost:3030' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const initialize = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    });
    const listTools = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    proc.stdin.write(initialize + '\n');
    proc.stdin.write(listTools + '\n');

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });

    setTimeout(() => {
      proc.kill();
      const lines = output.trim().split('\n').filter(Boolean);
      const toolsResponse = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .find(r => r?.id === 2);

      expect(toolsResponse).toBeTruthy();
      const toolNames = toolsResponse.result.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('rorca_get_context');
      expect(toolNames).toContain('rorca_create_spec');
      expect(toolNames).toContain('rorca_generate_spec');
      expect(toolNames).toContain('rorca_persist_spec');
      expect(toolNames).toContain('rorca_list_specs');
      expect(toolNames).toContain('rorca_approve_spec');
      expect(toolNames).toContain('rorca_pipeline_status');
      expect(toolNames).toContain('rorca_list_workspaces');
      expect(toolNames).toContain('rorca_trigger_run');
      expect(toolNames).toContain('rorca_run_status');
      expect(toolNames).toContain('rorca_retry_story');
      expect(toolNames).toContain('rorca_list_runs');
      expect(toolNames).toContain('rorca_edit_story');
      expect(toolNames).toContain('rorca_add_stories');
      expect(toolNames).toContain('rorca_delete_story');
      expect(toolNames).toContain('rorca_save_memory');
      expect(toolNames).toContain('rorca_get_memories');
      done();
    }, 6000);
  }, 15000);
});
