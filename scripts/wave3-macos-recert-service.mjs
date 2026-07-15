#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Disposable launchd fixture used only by wave3-macos-recert-lifecycle.mjs.
 * It accepts a nonce-bound JSON config under /private/tmp and never imports
 * the application runtime or connects to a database.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const configPath = process.argv[2];
if (!configPath) throw new Error('fixture config path is required');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.resolve(config.root);
const resolvedConfig = path.resolve(configPath);
if (!root.startsWith('/private/tmp/rorca-final-macos-recert-')
  || !resolvedConfig.startsWith(`${root}${path.sep}`)
  || !/^[a-f0-9]{16}$/.test(config.nonce)
  || !['backend', 'worker', 'capture', 'monitor'].includes(config.role)) {
  throw new Error('unsafe disposable fixture configuration');
}

const stateDir = path.join(root, 'state');
const logsDir = path.join(root, 'logs');
const statusPath = path.join(stateDir, `${config.role}.status.json`);
const managedLog = path.join(logsDir, `${config.role}.managed.log`);
const queuePath = path.join(stateDir, 'worker.queue.ndjson');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });

function assertInside(file) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe fixture path: ${resolved}`);
  return resolved;
}

function rotateLogIfNeeded() {
  const limit = 1024;
  if (fs.existsSync(managedLog) && fs.statSync(managedLog).size >= limit) {
    const rotated = assertInside(`${managedLog}.1`);
    fs.rmSync(rotated, { force: true });
    fs.renameSync(managedLog, rotated);
  }
}

function now() { return new Date().toISOString(); }
function writeStatus(event) {
  const status = {
    nonce: config.nonce,
    role: config.role,
    pid: process.pid,
    cwd: process.cwd(),
    event,
    updatedAt: now(),
    ...(config.role === 'worker' ? { queueBytes: fs.existsSync(queuePath) ? fs.statSync(queuePath).size : 0 } : {}),
  };
  const temporary = assertInside(`${statusPath}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statusPath);
  return status;
}

rotateLogIfNeeded();
fs.appendFileSync(managedLog, `${now()} nonce=${config.nonce} role=${config.role} pid=${process.pid} event=start\n`, { mode: 0o600 });
if (config.role === 'worker' && !fs.existsSync(queuePath)) {
  fs.writeFileSync(queuePath, `${JSON.stringify({ nonce: config.nonce, preserved: true, seededAt: now() })}\n`, { mode: 0o600 });
}
writeStatus('start');

let server;
if (config.role === 'backend') {
  server = http.createServer((request, response) => {
    if (request.url === '/ready') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true, nonce: config.nonce, role: config.role, pid: process.pid }));
      return;
    }
    response.writeHead(404); response.end();
  });
  server.listen(config.port, '127.0.0.1');
}

const heartbeat = setInterval(() => {
  if (config.role === 'monitor') {
    const capture = path.join(stateDir, 'capture.status.json');
    const captureFresh = fs.existsSync(capture) && Date.now() - fs.statSync(capture).mtimeMs < 15_000;
    fs.writeFileSync(path.join(stateDir, 'monitor.observation.json'), `${JSON.stringify({ nonce: config.nonce, captureFresh, observedAt: now() })}\n`, { mode: 0o600 });
  }
  fs.appendFileSync(managedLog, `${now()} nonce=${config.nonce} role=${config.role} pid=${process.pid} event=heartbeat\n`, { mode: 0o600 });
  writeStatus('heartbeat');
}, 500);

function stop(signal) {
  clearInterval(heartbeat);
  fs.appendFileSync(managedLog, `${now()} nonce=${config.nonce} role=${config.role} pid=${process.pid} event=stop signal=${signal}\n`, { mode: 0o600 });
  writeStatus('stop');
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
