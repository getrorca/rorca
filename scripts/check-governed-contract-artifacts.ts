/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'packages/rorca-public-contract/schemas/governed-execution');
const snapshot = () => new Map(fs.existsSync(directory) ? fs.readdirSync(directory).sort().map((file) => [file, fs.readFileSync(path.join(directory, file))] as const) : []);
const before = snapshot();
const command = process.execPath;
const tsx = path.join(root, 'backend/node_modules/tsx/dist/cli.mjs');
const result = spawnSync(command, [tsx, path.join(root, 'scripts/generate-governed-contract-artifacts.ts')], { cwd: root, encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'governed contract generation failed');
const after = snapshot();
const changed = [...new Set([...before.keys(), ...after.keys()])].filter((file) => !before.get(file)?.equals(after.get(file) ?? Buffer.alloc(0)));
if (changed.length) {
  console.error(`Governed contract artifacts are stale: ${changed.join(', ')}`);
  process.exit(1);
}
console.log(`Governed contract artifacts stable: ${after.size} files`);
