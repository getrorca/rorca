/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runNoisyRecoveryHarness } from './lib/pty-noisy-release-harness';

async function main(): Promise<void> {
  const outputFlag = process.argv.indexOf('--output');
  const outputPath = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
  if (outputFlag >= 0 && !outputPath) throw new Error('--output requires a repository-relative JSON path');
  const repositoryRoot = path.resolve(__dirname, '..', '..');
  const resolvedOutput = outputPath ? path.resolve(repositoryRoot, outputPath) : undefined;
  const relativeOutput = resolvedOutput ? path.relative(repositoryRoot, resolvedOutput) : undefined;
  if (resolvedOutput && (
    path.isAbsolute(outputPath!)
    || !relativeOutput
    || relativeOutput.startsWith(`..${path.sep}`)
    || path.extname(relativeOutput) !== '.json'
  )) {
    throw new Error('benchmark output must use a contained repository-relative JSON path');
  }

  const benchmark = await runNoisyRecoveryHarness();
  const json = `${JSON.stringify(benchmark, null, 2)}\n`;
  if (resolvedOutput) await writeFile(resolvedOutput, json, 'utf8');
  process.stdout.write(json);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
