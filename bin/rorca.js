#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const tsEntry = resolve(__dirname2, 'rorca.ts');
const req = createRequire(import.meta.url);

let tsxBin = null;
try {
  tsxBin = req.resolve('.bin/tsx', { paths: [resolve(__dirname2, '../node_modules')] });
} catch {}

const result = tsxBin
  ? spawnSync(tsxBin, [tsEntry, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
  : spawnSync('npx', ['tsx', tsEntry, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });

process.exit(result.status ?? 1);
