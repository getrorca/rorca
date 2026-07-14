import * as fs from 'fs';
import * as path from 'path';

export interface PrepareRunSpecSnapshotOptions {
  runId: number;
  sourceSpecPath: string;
  worktreePath: string | null;
}

/**
 * Isolated runs must never mutate passes/skipped flags in the source workspace's
 * approved spec. Copy the executable JSON into the worktree's ignored runtime
 * directory and let execution-engine mutate only that run-owned snapshot.
 */
export function prepareRunSpecSnapshot({
  runId,
  sourceSpecPath,
  worktreePath,
}: PrepareRunSpecSnapshotOptions): string {
  if (!worktreePath) return sourceSpecPath;
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Invalid run ID for spec snapshot');
  if (!fs.existsSync(sourceSpecPath)) throw new Error(`Run spec not found: ${sourceSpecPath}`);

  const worktreeRoot = path.resolve(worktreePath);
  const runtimeDir = path.resolve(worktreeRoot, '.rorca', 'run-specs');
  if (runtimeDir !== worktreeRoot && !runtimeDir.startsWith(`${worktreeRoot}${path.sep}`)) {
    throw new Error('Run spec snapshot escaped the worktree');
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
  const snapshotPath = path.join(runtimeDir, `run-${runId}.json`);
  fs.copyFileSync(sourceSpecPath, snapshotPath);
  return snapshotPath;
}
