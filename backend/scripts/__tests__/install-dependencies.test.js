#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installBackendDependencies } = require('../install-dependencies.js');

function recordingSpawn(results = []) {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return results.shift() ?? { status: 0 };
    },
  };
}

test('checkout lifecycle restores locked node-pty scripts before verification', () => {
  const recorder = recordingSpawn();
  const status = installBackendDependencies({ spawn: recorder.spawn, repositoryCheckout: true });

  assert.equal(status, 0);
  assert.deepEqual(recorder.calls.map(({ command, args }) => [command, args]), [
    [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts']],
    [process.platform === 'win32' ? 'npm.cmd' : 'npm', [
      'rebuild',
      'node-pty',
      '--ignore-scripts=false',
      '--foreground-scripts',
    ]],
    [process.execPath, ['scripts/verify-node-pty-install.js']],
  ]);
  assert.equal(recorder.calls[1].options.cwd.endsWith('/backend'), true);
});

test('packed lifecycle preserves production-only install and fails before verification', () => {
  const recorder = recordingSpawn([{ status: 0 }, { status: 17 }]);
  const status = installBackendDependencies({ spawn: recorder.spawn, repositoryCheckout: false });

  assert.equal(status, 17);
  assert.deepEqual(recorder.calls.map(({ args }) => args), [
    ['install', '--omit=dev', '--ignore-scripts'],
    ['rebuild', 'node-pty', '--ignore-scripts=false', '--foreground-scripts'],
  ]);
});
