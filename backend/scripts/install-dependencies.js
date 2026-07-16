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

function runCommand(command, args, spawn = spawnSync) {
  const result = spawn(command, args, {
    cwd: backendDir,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function installBackendDependencies({ spawn = spawnSync, repositoryCheckout = isRepositoryCheckout } = {}) {
  const dependencyInstallArgs = repositoryCheckout
    ? ['ci', '--ignore-scripts']
    : ['install', '--omit=dev', '--ignore-scripts'];

  // The first install deliberately suppresses every lifecycle hook so root
  // postinstall cannot recursively invoke this verifier. Restore the one native
  // dependency we need through npm's locked package lifecycle instead of relying
  // on a cached prebuild from a previous host or architecture.
  let status = runCommand(npmCommand, dependencyInstallArgs, spawn);
  if (status !== 0) return status;

  // node-pty's own install script selects the current platform prebuild or
  // compiles from source. The explicit false wins over ambient npm config and
  // keeps the root clean-install path reproducible on Linux, macOS, and Windows.
  status = runCommand(npmCommand, [
    'rebuild',
    'node-pty',
    '--ignore-scripts=false',
    '--foreground-scripts',
  ], spawn);
  if (status !== 0) return status;

  return runCommand(process.execPath, ['scripts/verify-node-pty-install.js'], spawn);
}

if (require.main === module) process.exit(installBackendDependencies());

module.exports = { installBackendDependencies };
