/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import path from 'path';
import {
  buildSnapshotFromOpenApi,
  bumpVersion,
  compareSnapshots,
  determineBumpType,
  readSnapshot,
  writeContractMarkdown,
  writeSnapshot,
} from '../packages/rorca-public-contract/src/index';
import { loadOpenApiDocument } from './openapi-source';

const cwd = process.cwd();
const docsDir = path.join(cwd, 'docs');
const snapshotPath = path.join(docsDir, 'openapi-public-snapshot.json');
const markdownPath = path.join(docsDir, 'OPEN_API_CONTRACT.md');
async function main(): Promise<void> {
  const existingSnapshot = await readSnapshot(snapshotPath);
  const openApi = await loadOpenApiDocument();

  const provisionalVersion = existingSnapshot?.contractVersion ?? '1.0.0';
  const provisionalSnapshot = buildSnapshotFromOpenApi(
    openApi,
    provisionalVersion,
    existingSnapshot?.generatedAt,
  );

  let nextVersion = provisionalVersion;
  let generatedAt = existingSnapshot?.generatedAt;
  if (existingSnapshot) {
    const changes = compareSnapshots(existingSnapshot, provisionalSnapshot, openApi);
    const bumpType = determineBumpType(changes);
    nextVersion = bumpVersion(existingSnapshot.contractVersion, bumpType);
    // A no-op rebuild must be byte-identical. Timestamp drift would make the
    // release certification gate mutate an otherwise frozen source candidate.
    if (bumpType !== 'none') generatedAt = new Date().toISOString();
  }

  const finalSnapshot = buildSnapshotFromOpenApi(openApi, nextVersion, generatedAt);
  await writeSnapshot(snapshotPath, finalSnapshot);
  await writeContractMarkdown(markdownPath, finalSnapshot);

  console.log(`Wrote ${path.relative(cwd, snapshotPath)} and ${path.relative(cwd, markdownPath)} (${finalSnapshot.routes.length} public routes, contract ${finalSnapshot.contractVersion})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
