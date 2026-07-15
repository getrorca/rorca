/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * The narrowly authorized approved-spec pass mutation seam.
 *
 * Callers must hold the workspace/spec transaction lock and provide the exact
 * raw content they classified. This helper snapshots that content before one
 * atomic false→true projection update and appends auditable WAL evidence.
 */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import type {
  ApprovedSpecDocument,
  PassReconcilerClient,
  StoryPassReconciliation,
} from './ssdlc-pass-reconciler';

export interface ApprovedSpecPassWriteResult {
  spec: ApprovedSpecDocument;
  snapshotVersion: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stories(spec: ApprovedSpecDocument): Array<Record<string, unknown>> {
  if (Array.isArray(spec.userStories)) return spec.userStories as Array<Record<string, unknown>>;
  if (!Array.isArray(spec.phases)) return [];
  return (spec.phases as Array<{ stories?: unknown }>).flatMap((phase) =>
    Array.isArray(phase.stories) ? phase.stories as Array<Record<string, unknown>> : []);
}

/** Atomic same-directory replacement preserves readers from partial JSON. */
export function writeApprovedSpecAtomically(filePath: string, content: string): void {
  const tempPath = `${filePath}.pass-${process.pid}-${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: fs.statSync(filePath).mode });
  fs.renameSync(tempPath, filePath);
}

/**
 * Batch equivalent of the engine's markStoryPassed projection helper. A batch
 * gets one pre-image snapshot so concurrent wave reconciliation cannot create
 * partially versioned story flags.
 */
export async function markStoriesPassed(input: {
  client: PassReconcilerClient;
  workspaceId: string;
  specId: string;
  absoluteSpecPath: string;
  rawBefore: string;
  specBefore: ApprovedSpecDocument;
  repairs: StoryPassReconciliation[];
  readCurrentFile?: (filePath: string) => string;
  writeFileAtomically?: (filePath: string, content: string) => void;
}): Promise<ApprovedSpecPassWriteResult> {
  if (input.repairs.length === 0) throw new TypeError('markStoriesPassed requires at least one safe repair');

  const versionResult = await input.client.query<{ next_version: number }>(`
    SELECT COALESCE(MAX(version), 0) + 1 AS next_version
    FROM spec_versions WHERE spec_slug = $1
  `, [input.specId]);
  const snapshotVersion = Number(versionResult.rows[0]?.next_version ?? 1);
  await input.client.query(`
    INSERT INTO spec_versions (workspace_id, spec_slug, version, content_json, status)
    VALUES ($1, $2, $3, $4::jsonb, 'approved')
  `, [input.workspaceId, input.specId, snapshotVersion, input.rawBefore]);

  const repairedSpec = clone(input.specBefore);
  const repairIds = new Set(input.repairs.map((repair) => repair.storyId));
  for (const story of stories(repairedSpec)) {
    if (typeof story.id !== 'string' || !repairIds.has(story.id)) continue;
    if (story.passes === true) continue;
    story.passes = true;
    story.notes = 'Completed by Rorca pass reconciler';
  }
  for (const repaired of input.repairs) {
    await input.client.query(`
      INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload)
      VALUES ('story_reconciled', $1, $2, $3, 'rorca-pass-reconciler', $4::jsonb)
    `, [input.workspaceId, input.specId, repaired.storyId, JSON.stringify({
      from: false,
      to: true,
      reason_codes: repaired.reasonCodes,
      evidence_references: repaired.evidenceReferences,
      spec_version_snapshot: snapshotVersion,
    })]);
  }

  // Keep filesystem mutation last: any snapshot/WAL failure still rolls the DB
  // transaction back while leaving the approved file untouched. Reassert the
  // classified pre-image immediately before the conditional write.
  const currentRaw = (input.readCurrentFile ?? ((filePath: string) => fs.readFileSync(filePath, 'utf8')))(input.absoluteSpecPath);
  if (currentRaw !== input.rawBefore) {
    throw new TypeError('Approved spec changed before the conditional pass update');
  }
  const serialized = `${JSON.stringify(repairedSpec, null, 2)}\n`;
  (input.writeFileAtomically ?? writeApprovedSpecAtomically)(input.absoluteSpecPath, serialized);

  return { spec: repairedSpec, snapshotVersion };
}
