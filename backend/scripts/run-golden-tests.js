#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */


const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runGoldenTests(args = process.argv.slice(2), spawn = spawnSync) {
  const updateGolden = args.includes('--update-golden');
  const forwardedArgs = args.filter((arg) => arg !== '--update-golden');
  const env = { ...process.env };

  if (updateGolden) {
    env.RORCA_UPDATE_GOLDEN = '1';
  }

  const result = spawn(
    process.execPath,
    [
      require.resolve('tsx/cli'),
      path.resolve(__dirname, 'run-isolated-jest.ts'),
      '--testPathPattern=golden',
      ...forwardedArgs,
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      env,
      stdio: 'inherit',
    },
  );

  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (require.main === module) {
  try {
    process.exitCode = runGoldenTests();
  } catch (error) {
    console.error('[golden-owner] failed to launch isolated Jest:', error);
    process.exitCode = 1;
  }
}

module.exports = { runGoldenTests };
