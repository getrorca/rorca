/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

function append(event) {
  const target = process.env.RORCA_TEST_RETRY_PROCESS_AUDIT;
  if (target) fs.appendFileSync(target, `${JSON.stringify({ ...event, at: Date.now() })}\n`);
}

let started = false;
process.on('message', (message) => {
  if (!message || message.type !== 'launch_start' || started) return;
  started = true;
  if (process.send) process.send({ type: 'pid', pid: process.pid });
  append({ type: 'engine', pid: process.pid });
  const delay = Number(process.env.RORCA_TEST_RETRY_PROVIDER_DELAY_MS || 80);
  const provider = spawn(process.execPath, ['-e', `setTimeout(() => process.exit(0), ${Math.max(1, delay)})`], {
    stdio: 'ignore',
  });
  append({ type: 'provider', pid: provider.pid, enginePid: process.pid });
  const forward = (signal) => {
    try { provider.kill(signal); } catch {}
  };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));
  provider.once('close', (code, signal) => {
    append({ type: 'provider_close', pid: provider.pid, code, signal });
    process.exit(signal ? 143 : Number(process.env.RORCA_TEST_RETRY_ENGINE_EXIT_CODE || code || 0));
  });
});

setInterval(() => {}, 1000).unref();
