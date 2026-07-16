#!/usr/bin/env node
import { chmodSync, existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'packages', 'rorca-capture', 'dist', 'cli.js');
if (!existsSync(cli)) throw new Error(`Capture CLI build output is missing: ${cli}`);
rmSync(path.join(root, 'packages', 'rorca-capture', 'dist', '__tests__'), { recursive: true, force: true });
if (process.platform !== 'win32') {
  chmodSync(cli, 0o755);
  if ((statSync(cli).mode & 0o111) !== 0o111) throw new Error('Capture CLI build output is not executable.');
}
