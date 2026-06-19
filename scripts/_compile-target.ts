#!/usr/bin/env bun
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Compile Rorca binary for a specific bun target.
 * Called by scripts/build-binaries.sh for each platform.
 *
 * Usage: bun run scripts/_compile-target.ts <target> <outpath>
 *   target:  bun-darwin-arm64 | bun-darwin-x64 | bun-linux-x64 | bun-windows-x64
 *   outpath: absolute path for the output binary
 */

import { join } from 'path';
import { readFileSync, existsSync, renameSync, unlinkSync, statSync } from 'fs';

const ROOT = join(import.meta.dir, '..');
const BUN_SHIM = join(ROOT, 'backend', 'src', 'db', 'bun-sqlite-shim.ts');
const ENTRY = join(ROOT, 'bin', 'rorca-bun.ts');

const target = process.argv[2] as import('bun').Target;
const outpath = process.argv[3];

if (!target || !outpath) {
  console.error('Usage: bun run _compile-target.ts <target> <outpath>');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

const betterSqlitePlugin: import('bun').BunPlugin = {
  name: 'better-sqlite3-to-bun-sqlite',
  setup(build) {
    build.onResolve({ filter: /^better-sqlite3$/ }, () => {
      return { path: BUN_SHIM };
    });
  },
};

const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: join(ROOT, 'build'),
  compile: true,
  target,
  minify: true,
  define: {
    'RORCA_VERSION': JSON.stringify(pkg.version),
  },
  naming: {
    asset: '[name].[ext]',
  },
  plugins: [betterSqlitePlugin],
  external: ['fsevents'],
});

if (!result.success) {
  console.error('    Compilation failed:');
  for (const log of result.logs) {
    console.error(`      ${log}`);
  }
  process.exit(1);
}

// Bun outputs the binary with the entry point filename — rename to desired output
const compiledOutput = result.outputs.find(o => o.kind === 'entry-point');
if (compiledOutput && compiledOutput.path !== outpath) {
  if (existsSync(outpath)) {
    unlinkSync(outpath);
  }
  renameSync(compiledOutput.path, outpath);
}
