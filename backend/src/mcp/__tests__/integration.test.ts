import { spawn } from 'child_process';
import * as path from 'path';

describe('MCP server integration', () => {
  it('lists all 9 expected tools', (done) => {
    const proc = spawn('npx', ['tsx', path.resolve(__dirname, '../server.ts')], {
      env: { ...process.env, NODE_ENV: 'production', RORCHA_API_URL: 'http://localhost:3030' },
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
      expect(toolNames).toContain('rorcha_get_context');
      expect(toolNames).toContain('rorcha_generate_spec');
      expect(toolNames).toContain('rorcha_list_specs');
      expect(toolNames).toContain('rorcha_approve_spec');
      expect(toolNames).toContain('rorcha_pipeline_status');
      expect(toolNames).toContain('rorcha_edit_story');
      expect(toolNames).toContain('rorcha_search_stories');
      expect(toolNames).toContain('rorcha_add_stories');
      expect(toolNames).toContain('rorcha_delete_story');
      done();
    }, 6000);
  }, 15000);
});
