/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { execute, queryOne, transaction } from '../../db/index';
import {
  advanceDurableWaveIntegration,
  prepareDurableWaveIntegration,
  readExactFinalizedStoryIntegration,
  readDurableWaveIntegration,
  type DurableWaveIntegrationIdentity,
} from '../wave-integration-store';

const SHA = (character: string): string => character.repeat(40);
const HASH = (character: string): string => character.repeat(64);

test('production integration store persists exact identity and refuses validation without a host recovery packet', async () => {
  const workspaceId = `wave-store-${randomUUID()}`;
  let runId: number | undefined;
  try {
    await execute(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Wave store test', '/tmp')`,
      [workspaceId],
    );
    runId = Number((await queryOne<{ id: string | number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status)
       VALUES ('forge/specs/approved/wave-store.json', $1, 'running') RETURNING id`,
      [workspaceId],
    ))!.id);
    const identity: DurableWaveIntegrationIdentity = {
      runId,
      storyId: 'WPE-STORE-001',
      attempt: 1,
      waveIndex: 2,
      integrationOrder: 200_000,
      sourceCommit: SHA('a'),
      sourceBaseCommit: SHA('b'),
      expectedParentHead: SHA('b'),
      frozenManifestHash: HASH('c'),
    };

    expect((await prepareDurableWaveIntegration(identity)).state).toBe('prepared');
    expect((await prepareDurableWaveIntegration(identity)).state).toBe('prepared');
    expect((await advanceDurableWaveIntegration({ identity, from: 'prepared', to: 'integrating' })).state).toBe('integrating');
    expect((await advanceDurableWaveIntegration({
      identity, from: 'integrating', to: 'integrated', resultingHead: SHA('d'),
    })).state).toBe('integrated');
    const validationIdentity = {
      validator: 'test-validator', revision: SHA('d'), treeHash: SHA('e'), contractHash: HASH('f'),
    };
    await expect(advanceDurableWaveIntegration({
      identity,
      from: 'integrated',
      to: 'integrated_validated',
      resultingHead: SHA('d'),
      validationIdentity,
    })).rejects.toThrow(/immutable host recovery packet/);
    expect(await readDurableWaveIntegration({ runId, storyId: identity.storyId, attempt: 1 }))
      .toMatchObject({ state: 'integrated', integrationOrder: 200_000 });
    await expect(advanceDurableWaveIntegration({
      identity: { ...identity, expectedParentHead: SHA('9') },
      from: 'integrated',
      to: 'integrated_validated',
      resultingHead: SHA('d'),
      validationIdentity,
    })).rejects.toThrow(/identity is missing or stale/);
  } finally {
    if (runId) await execute('DELETE FROM pipeline_runs WHERE id = $1', [runId]).catch(() => undefined);
    await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]).catch(() => undefined);
  }
});

test('governed retry resolves a reconciled integration by exact result when engine attempts advanced', async () => {
  const workspaceId = `wave-store-retry-${randomUUID()}`;
  let runId: number | undefined;
  try {
    await execute(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Wave retry store test', '/tmp')`,
      [workspaceId],
    );
    runId = Number((await queryOne<{ id: string | number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status)
       VALUES ('forge/specs/approved/wave-store-retry.json', $1, 'running') RETURNING id`,
      [workspaceId],
    ))!.id);
    await execute(
      `INSERT INTO story_integration_ledger (
         run_id, story_id, attempt, wave_index, integration_order, state,
         source_commit, source_base_commit, expected_parent_head, resulting_head,
         frozen_manifest_hash, validation_identity, finalization_identity, finalized_at
       ) VALUES ($1, 'WPE-STORE-RETRY-001', 3, 0, 0, 'finalized',
         $2, $3, $3, $2, $4, $5::jsonb, $6::jsonb, NOW())`,
      [
        runId,
        SHA('d'),
        SHA('a'),
        HASH('b'),
        JSON.stringify({ storyResultId: 90210 }),
        JSON.stringify({ idempotencyKey: 'sequential-integration:test', revision: SHA('d') }),
      ],
    );

    const matched = await transaction((client) => readExactFinalizedStoryIntegration(client, {
      runId: runId!,
      storyId: 'WPE-STORE-RETRY-001',
      governedAttempt: 2,
      storyResultId: 90210,
      resultingHead: SHA('d'),
    }));
    expect(matched).toMatchObject({
      attempt: 3,
      sourceCommit: SHA('d'),
      resultingHead: SHA('d'),
    });

    const staleResult = await transaction((client) => readExactFinalizedStoryIntegration(client, {
      runId: runId!,
      storyId: 'WPE-STORE-RETRY-001',
      governedAttempt: 2,
      storyResultId: 90211,
      resultingHead: SHA('d'),
    }));
    expect(staleResult).toBeUndefined();
  } finally {
    if (runId) await execute('DELETE FROM pipeline_runs WHERE id = $1', [runId]).catch(() => undefined);
    await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]).catch(() => undefined);
  }
});
