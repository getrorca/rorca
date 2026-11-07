/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { runGoldenTests } = require('../run-golden-tests');

test('golden corpus runs through the nonce-owning isolated Jest wrapper', () => {
  let invocation;
  const exitCode = runGoldenTests(['--runInBand'], (command, args, options) => {
    invocation = { command, args, options };
    return { status: 0 };
  });

  assert.equal(exitCode, 0);
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[0], require.resolve('tsx/cli'));
  assert.equal(invocation.args[1], path.resolve(__dirname, '..', 'run-isolated-jest.ts'));
  assert.deepEqual(invocation.args.slice(2), ['--testPathPattern=golden', '--runInBand']);
  assert.equal(invocation.options.cwd, path.resolve(__dirname, '..', '..'));
});

test('golden updates stay inside isolated ownership and are explicit', () => {
  let invocation;
  const exitCode = runGoldenTests(['--update-golden', '--runInBand'], (_command, args, options) => {
    invocation = { args, options };
    return { status: 0 };
  });

  assert.equal(exitCode, 0);
  assert.equal(invocation.options.env.RORCA_UPDATE_GOLDEN, '1');
  assert.deepEqual(invocation.args.slice(2), ['--testPathPattern=golden', '--runInBand']);
});

test('golden runner propagates harness launch failures', () => {
  assert.throws(
    () => runGoldenTests([], () => ({ status: null, error: new Error('spawn failed') })),
    /spawn failed/,
  );
});
