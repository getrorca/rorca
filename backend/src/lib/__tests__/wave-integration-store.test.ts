/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { execute, queryOne } from '../../db/index';
import {
  advanceDurableWaveIntegration,
  prepareDurableWaveIntegration,
  readDurableWaveIntegration,
  type DurableWaveIntegrationIdentity,
} from '../wave-integration-store';

const SHA = (character: string): string => character.repeat(40);
const HASH = (character: string): string => character.repeat(64);

test('production integration store persists and replays the exact validated state machine', async () => {
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
    expect((await advanceDurableWaveIntegration({
      identity,
      from: 'integrated',
      to: 'integrated_validated',
      resultingHead: SHA('d'),
      validationIdentity,
    }))).toMatchObject({ state: 'integrated_validated', resultingHead: SHA('d'), validationIdentity });
    expect(await readDurableWaveIntegration({ runId, storyId: identity.storyId, attempt: 1 }))
      .toMatchObject({ state: 'integrated_validated', integrationOrder: 200_000 });
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
