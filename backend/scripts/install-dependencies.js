#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const backendDir = resolve(__dirname, '..');
const repositoryRoot = resolve(backendDir, '..');
const isRepositoryCheckout = existsSync(resolve(repositoryRoot, '.git'));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const installArgs = isRepositoryCheckout
  ? ['ci', '--ignore-scripts']
  : ['install', '--omit=dev', '--ignore-scripts'];

const install = spawnSync(npmCommand, installArgs, {
  cwd: backendDir,
  env: process.env,
  stdio: 'inherit',
});
if (install.error) throw install.error;
if (install.status !== 0) process.exit(install.status ?? 1);

const verify = spawnSync(process.execPath, ['scripts/verify-node-pty-install.js'], {
  cwd: backendDir,
  env: process.env,
  stdio: 'inherit',
});
if (verify.error) throw verify.error;
process.exit(verify.status ?? 1);
