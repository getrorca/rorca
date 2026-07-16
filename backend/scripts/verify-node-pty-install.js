/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const fs = require('node:fs');
const path = require('node:path');

function findSpawnHelpers(root, found = []) {
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) findSpawnHelpers(file, found);
    else if (entry.name === 'spawn-helper') found.push(file);
  }
  return found;
}

async function main() {
  const nodePty = require('node-pty');
  const packageRoot = path.dirname(require.resolve('node-pty/package.json'));
  const helpers = [
    ...findSpawnHelpers(path.join(packageRoot, 'prebuilds')),
    ...findSpawnHelpers(path.join(packageRoot, 'build', 'Release')),
  ];

  for (const helper of helpers) fs.chmodSync(helper, 0o755);
  if (process.platform !== 'win32' && helpers.length === 0) {
    throw new Error('node-pty spawn-helper was not packaged');
  }
  for (const helper of helpers) {
    if ((fs.statSync(helper).mode & 0o111) === 0) {
      throw new Error(`node-pty spawn-helper is not executable: ${helper}`);
    }
  }

  const marker = `rorca-node-pty-smoke-${process.pid}`;
  const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `echo ${marker}`] : ['-c', `printf '${marker}\\n'`];
  const child = nodePty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  });

  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      reject(new Error('node-pty spawn smoke timed out'));
    }, 5_000);
    timer.unref?.();
    child.onData((data) => { output += data; });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0) reject(new Error(`node-pty smoke exited ${exitCode}`));
      else resolve();
    });
  });

  if (!output.includes(marker)) throw new Error('node-pty spawn smoke produced unexpected output');
  console.log(`node-pty verified (${process.platform}/${process.arch}); spawn-helper executable; require+spawn passed`);
}

main().catch((error) => {
  console.error(`node-pty verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
