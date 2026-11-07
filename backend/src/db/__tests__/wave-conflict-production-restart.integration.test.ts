/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { assertConnectedTestDatabase, resolveTestDatabaseUrl } from '../../lib/test-db-safety';
import { persistDurableWaveConflictAbortFromRecord } from '../../lib/execution-engine';
import {
  WaveConflictAbort,
  WaveIntegrationLedger,
  type WaveContributionIdentity,
} from '../../lib/wave-integration-protocol';
import {
  advanceDurableWaveIntegration,
  failDurableWaveIntegration,
  prepareDurableWaveIntegration,
  readDurableWaveIntegration,
  type DurableWaveIntegrationIdentity,
} from '../../lib/wave-integration-store';

const connectionString = resolveTestDatabaseUrl();
const pool = new Pool({ connectionString, max: 2 });
const sha256 = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('production wave conflict catch persistence and restart (real PostgreSQL/Git)', () => {
  const workspaceId = `wave-conflict-${crypto.randomUUID()}`;
  const storyId = 'US-WAVE-CONFLICT-001';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wave-conflict-'));
  const repository = path.join(root, 'repository');
  const manifestPath = path.join(root, 'manifest.json');
  const targetBranch = `cert/target-${crypto.randomUUID()}`;
  const sourceBranch = `cert/source-${crypto.randomUUID()}`;
  let runId: number;
  let targetHead: string;
  let identity: WaveContributionIdentity;
  let durableIdentity: DurableWaveIntegrationIdentity;

  beforeAll(async () => {
    await assertConnectedTestDatabase(pool, connectionString);
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ['init', '-b', targetBranch]);
    git(repository, ['config', 'user.email', 'cert@example.test']);
    git(repository, ['config', 'user.name', 'Rorca Certification']);
    fs.writeFileSync(path.join(repository, 'shared.txt'), 'base\n');
    git(repository, ['add', 'shared.txt']);
    git(repository, ['commit', '-m', 'base']);
    const base = git(repository, ['rev-parse', 'HEAD']);
    git(repository, ['branch', sourceBranch, base]);

    fs.writeFileSync(path.join(repository, 'shared.txt'), 'target edit\n');
    git(repository, ['commit', '-am', 'target same-hunk edit']);
    targetHead = git(repository, ['rev-parse', 'HEAD']);

    git(repository, ['checkout', sourceBranch]);
    fs.writeFileSync(path.join(repository, 'shared.txt'), 'source edit\n');
    git(repository, ['commit', '-am', 'source same-hunk edit']);
    const sourceHead = git(repository, ['rev-parse', 'HEAD']);
    git(repository, ['checkout', targetBranch]);

    fs.writeFileSync(manifestPath, JSON.stringify({ storyId, base, sourceHead, targetHead }));
    const manifestHash = sha256(fs.readFileSync(manifestPath));
    await pool.query(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Wave conflict fixture', $2)`,
      [workspaceId, repository],
    );
    runId = Number((await pool.query<{ id: string }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, branch_name,
          execution_workspace_path, execution_worktree_path)
       VALUES ('wave-conflict.json', $1, 'running', $2, $3, $3) RETURNING id`,
      [workspaceId, targetBranch, repository],
    )).rows[0].id);

    identity = {
      runId,
      waveIndex: 1,
      storyId,
      attempt: 1,
      sourceRef: `refs/heads/${sourceBranch}`,
      sourceCommit: sourceHead,
      sourceBaseCommit: base,
      expectedParentHead: targetHead,
      frozenManifestPath: manifestPath,
      frozenManifestHash: manifestHash,
    };
    durableIdentity = {
      runId,
      storyId,
      attempt: 1,
      waveIndex: 1,
      integrationOrder: 1,
      sourceCommit: sourceHead,
      sourceBaseCommit: base,
      expectedParentHead: targetHead,
      frozenManifestHash: manifestHash,
    };
  });

  afterAll(async () => {
    if (runId) await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [runId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.end();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records conflicted then aborted evidence, survives restart, and never collapses to generic failed', async () => {
    await prepareDurableWaveIntegration(durableIdentity);
    await advanceDurableWaveIntegration({ identity: durableIdentity, from: 'prepared', to: 'integrating' });

    const ledger = new WaveIntegrationLedger(repository);
    ledger.prepare(identity);
    expect(() => ledger.integrate(identity)).toThrow(WaveConflictAbort);
    const fileRecord = ledger.get(identity);
    expect(fileRecord).toMatchObject({ state: 'aborted' });
    expect(fileRecord?.conflictEvidence?.conflictingFiles.map((file) => [file.path, file.kind]))
      .toEqual([['shared.txt', 'content']]);

    await persistDurableWaveConflictAbortFromRecord({ identity, durableIdentity, record: fileRecord });
    const persisted = await readDurableWaveIntegration({ runId, storyId, attempt: 1 });
    expect(persisted).toMatchObject({
      state: 'aborted',
      sourceCommit: identity.sourceCommit,
      expectedParentHead: targetHead,
    });
    expect(persisted?.conflictEvidence).toEqual(fileRecord?.conflictEvidence);
    expect(persisted?.failureReason).toMatch(/merge conflict in 1 bounded file identities; automatic resolution disabled/);
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(targetHead);
    expect(() => git(repository, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toThrow();

    const stateVersion = persisted!.stateVersion;
    const restartedRecord = new WaveIntegrationLedger(repository).get(identity);
    await persistDurableWaveConflictAbortFromRecord({
      identity,
      durableIdentity,
      record: restartedRecord,
    });
    const replayed = await readDurableWaveIntegration({ runId, storyId, attempt: 1 });
    expect(replayed?.state).toBe('aborted');
    expect(replayed?.stateVersion).toBe(stateVersion);
    expect(replayed?.conflictEvidence).toEqual(fileRecord?.conflictEvidence);

    const genericFailureAttempt = await failDurableWaveIntegration({
      identity: durableIdentity,
      reason: 'generic worker failure must not replace exact conflict attribution',
    });
    expect(genericFailureAttempt.state).toBe('aborted');
    expect(genericFailureAttempt.conflictEvidence).toEqual(fileRecord?.conflictEvidence);
  }, 60_000);
});
