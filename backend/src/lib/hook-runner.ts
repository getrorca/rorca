import { execSync } from 'child_process';
import { db } from '../db/index';

export interface PipelineHookRow {
  id: number;
  workspace_id: string;
  hook_type: 'pre_run' | 'post_run' | 'pre_story' | 'post_story';
  command: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface HookResult {
  hookId: number;
  command: string;
  exitCode: number;
  output: string;
}

/**
 * Run all enabled hooks of a given type for a workspace.
 * Returns array of results. Pre-run hooks abort on first non-zero exit.
 */
export function runHooks(
  workspaceId: string,
  hookType: PipelineHookRow['hook_type'],
  cwd: string,
  env: Record<string, string>,
): HookResult[] {
  const hooks = db.prepare(
    `SELECT * FROM pipeline_hooks WHERE workspace_id = ? AND hook_type = ? AND enabled = 1 ORDER BY id ASC`
  ).all(workspaceId, hookType) as PipelineHookRow[];

  const results: HookResult[] = [];

  for (const hook of hooks) {
    let output = '';
    let exitCode = 0;
    try {
      output = execSync(hook.command, {
        cwd,
        env,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      exitCode = err.status ?? 1;
      output = (err.stdout || '') + (err.stderr || '');
    }

    results.push({ hookId: hook.id, command: hook.command, exitCode, output });

    // Pre-run hooks abort on first failure
    if (hookType === 'pre_run' && exitCode !== 0) {
      break;
    }
  }

  return results;
}
