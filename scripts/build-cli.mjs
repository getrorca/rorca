#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'backend/package.json'));
const { build } = require('esbuild');
const entry = path.join(root, 'bin/rorca.ts');
const output = path.join(root, 'bin/rorca.js');

await build({
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Bundle the backend-only dependency graph so the published CLI never relies
  // on extensionless backend/src JavaScript shadows. Keep only optional/native
  // Node-resolved modules external.
  external: ['readline/promises', 'pg-native'],
  banner: {
    js: `/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);`,
  },
  sourcemap: false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
});

if (!fs.existsSync(output)) throw new Error(`CLI build output is missing: ${output}`);
const bytes = fs.readFileSync(output);
if (!bytes.toString('utf8', 0, 64).startsWith('#!/usr/bin/env node')) {
  throw new Error('CLI build output lost its executable shebang');
}
if (bytes.includes(Buffer.from('../backend/src/'))) {
  throw new Error('CLI build output retained a runtime dependency on backend source shadows');
}
if (process.platform !== 'win32') fs.chmodSync(output, 0o755);
console.log(`Built ${path.relative(root, output)} without backend source shadow modules (${bytes.length} bytes)`);
