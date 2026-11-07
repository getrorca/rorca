#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'packages/rorca-pi-extension/extensions/rorca/api.ts');
const runtimePath = path.join(root, 'packages/rorca-pi-extension/extensions/rorca/api.js');
const contractPath = path.join(root, 'packages/rorca-pi-extension/contracts/wave1-forge-mcp-contract.json');
const source = fs.readFileSync(sourcePath, 'utf8');
const generated = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    removeComments: false,
    newLine: ts.NewLineKind.LineFeed,
  },
  fileName: sourcePath,
  reportDiagnostics: true,
});
const backendRequire = createRequire(path.join(root, 'backend/package.json'));
const parityProbeOutput = execFileSync(process.execPath, [
  backendRequire.resolve('tsx/cli'),
  path.join(root, 'backend/scripts/check-wave1-mcp-runtime-parity.ts'),
], {
  cwd: path.join(root, 'backend'),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const parityMarker = '{\n  "schemaVersion": "rorca.wave1-forge-mcp-parity.v1"';
const parityStart = parityProbeOutput.indexOf(parityMarker);
if (parityStart < 0) {
  throw new Error('Canonical MCP runtime parity probe did not emit its contract');
}
const contract = `${JSON.stringify(JSON.parse(parityProbeOutput.slice(parityStart)), null, 2)}\n`;

const errors = (generated.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
if (errors.length > 0) {
  for (const diagnostic of errors) {
    console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  }
  process.exit(1);
}

if (process.argv.includes('--write')) {
  fs.writeFileSync(runtimePath, generated.outputText, { mode: 0o644 });
  fs.writeFileSync(contractPath, contract, { mode: 0o644 });
  console.log(`Generated ${path.relative(root, runtimePath)} from ${path.relative(root, sourcePath)}`);
  console.log(`Generated ${path.relative(root, contractPath)} from the canonical MCP runtime probe`);
  process.exit(0);
}

if (!fs.existsSync(runtimePath) || fs.readFileSync(runtimePath, 'utf8') !== generated.outputText) {
  console.error('Pi runtime drift detected: run `node scripts/generate-pi-runtime.mjs --write`.');
  process.exit(1);
}
if (!fs.existsSync(contractPath) || fs.readFileSync(contractPath, 'utf8') !== contract) {
  console.error('Pi packed MCP contract drift detected: run `node scripts/generate-pi-runtime.mjs --write`.');
  process.exit(1);
}
console.log('Pi TypeScript/runtime and packed MCP contract parity passed.');
