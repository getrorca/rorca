/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Independently measurable API/worker artifact lineage for Wave 1 closeout. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CLOSEOUT_RECONCILIATION_ARTIFACT_MANIFEST_VERSION =
  'rorca.closeout-reconciliation-artifact-manifest.v1' as const;

const LOGICAL_ARTIFACTS = [
  ['lib/closeout-reconciliation-artifact', 'closeout-reconciliation-artifact'],
  ['lib/closeout-reconciliation-build-identity', 'closeout-reconciliation-build-identity'],
  ['lib/run-closeout-reconciliation', 'run-closeout-reconciliation'],
  ['lib/run-closeout-authority', 'run-closeout-authority'],
  ['lib/run-host-authority', 'run-host-authority'],
  ['lib/wave-1-stabilization', 'wave-1-stabilization'],
  ['routes/recovery', '../routes/recovery'],
  ['worker', '../worker'],
] as const;

export interface CloseoutArtifactMeasurement {
  version: typeof CLOSEOUT_RECONCILIATION_ARTIFACT_MANIFEST_VERSION;
  digest: string;
  files: ReadonlyArray<Readonly<{ logicalPath: string; sha256: string; sizeBytes: number }>>;
}

function runtimeFile(stem: string): string {
  const extension = path.extname(__filename) === '.ts' ? '.ts' : '.js';
  const candidate = path.resolve(__dirname, `${stem}${extension}`);
  if (!fs.existsSync(candidate)) {
    throw new Error(`Required closeout runtime artifact is absent: ${stem}${extension}`);
  }
  return candidate;
}

export function measureCloseoutReconciliationArtifact(): CloseoutArtifactMeasurement {
  const files = LOGICAL_ARTIFACTS.map(([logicalPath, stem]) => {
    const bytes = fs.readFileSync(runtimeFile(stem));
    return Object.freeze({
      logicalPath,
      sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      sizeBytes: bytes.length,
    });
  });
  const canonical = JSON.stringify({
    version: CLOSEOUT_RECONCILIATION_ARTIFACT_MANIFEST_VERSION,
    files,
  });
  return Object.freeze({
    version: CLOSEOUT_RECONCILIATION_ARTIFACT_MANIFEST_VERSION,
    digest: `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`,
    files: Object.freeze(files),
  });
}
