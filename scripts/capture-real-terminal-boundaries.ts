#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runRealTerminalCertificationCapture } from '../backend/src/lib/real-terminal-certification';

function parseArgs(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument ${token}`);
    const key = token.slice(2);
    if (!['source-root', 'output', 'grant', 'credential-file'].includes(key)) throw new Error(`Unknown argument ${token}`);
    if (key in values) throw new Error(`Duplicate argument ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    values[key] = value;
    index += 1;
  }
  for (const key of ['output', 'grant', 'credential-file']) {
    if (!values[key]) throw new Error(`--${key} is required; provider capture never infers ambient authority`);
  }
  return values;
}

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  const values = parseArgs(process.argv.slice(2));
  const artifact = await runRealTerminalCertificationCapture({
    sourceRoot: path.resolve(values['source-root'] ?? scriptRoot),
    outputDir: path.resolve(values.output),
    grantFile: path.resolve(values.grant),
    credentialFile: path.resolve(values['credential-file']),
  });
  process.stdout.write(`Real terminal capture PASSED: ${JSON.stringify({
    output: path.resolve(values.output),
    status: artifact.status,
    actual: artifact.actual,
    skipped: artifact.skipped,
  })}\n`);
} catch (error) {
  process.stderr.write(`Real terminal capture FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
