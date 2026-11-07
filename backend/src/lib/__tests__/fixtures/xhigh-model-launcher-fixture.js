#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
/*
 * Trusted Linux acceptance fixture. Certification copies four byte-identical
 * regular files into a root-owned, non-writable tool root and names them
 * xhigh-claude, xhigh-pi, xhigh-codex, and xhigh-opencode. The production
 * launchers, bwrap, relay, broker, process streams, and cleanup remain real.
 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const kind = path.basename(process.argv[1]).replace(/^xhigh-/, '');
const args = process.argv.slice(2);
if (!['claude', 'pi', 'codex', 'opencode'].includes(kind)) process.exit(90);
const forbiddenOwnerEnvironment = [
  'RORCA_AUTONOMOUS_EGRESS_RUN_ID',
  'RORCA_AUTONOMOUS_EGRESS_OPERATION_ID',
  'RORCA_AUTONOMOUS_EGRESS_AUTHORITY_HASH',
  'RORCA_AUTONOMOUS_EGRESS_IDENTITY_HASH',
];
if (args.includes('--version')) {
  process.stdout.write(`${kind} 1.0.0\n`);
  process.exit(0);
}
if (forbiddenOwnerEnvironment.some(key => process.env[key])) process.exit(93);
if (process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET !== '/run/rorca-egress/proxy.sock') process.exit(93);

const started = path.join(process.cwd(), `.xhigh-${kind}-started`);
const release = path.join(process.cwd(), '.xhigh-release');
const fail = path.join(process.cwd(), '.xhigh-fail');
let completed = false;

function markStarted() {
  if (!fs.existsSync(started)) fs.writeFileSync(started, `${process.pid}\n`, { mode: 0o600 });
}

function connectStatus(host) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: 3128 });
    let response = '';
    const timeout = setTimeout(() => socket.destroy(new Error('broker response timeout')), 5000);
    socket.setEncoding('latin1');
    socket.on('connect', () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    socket.on('data', chunk => {
      response += chunk;
      const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
      if (match) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(Number(match[1]));
      }
    });
    socket.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      if (!/^HTTP\/1\.1 \d{3}/.test(response)) reject(new Error('broker returned no status'));
    });
  });
}

let brokerProof;
function proveBrokerBoundary() {
  brokerProof ??= Promise.all([
    connectStatus('model-api.example.invalid'),
    connectStatus('forbidden.example.invalid'),
  ]).then(([allowed, forbidden]) => {
    if (allowed !== 502 || forbidden !== 403) {
      throw new Error(`unexpected broker statuses ${allowed}/${forbidden}`);
    }
  });
  return brokerProof;
}

function waitForRelease(complete) {
  proveBrokerBoundary().then(() => {
    markStarted();
    poll();
  }, error => {
    process.stderr.write(`xhigh ${kind} broker proof failed: ${error.message}\n`);
    process.exit(94);
  });
  const deadline = Date.now() + 30_000;
  const poll = () => {
    if (completed) return;
    if (fs.existsSync(fail)) {
      completed = true;
      complete(true);
      return;
    }
    if (fs.existsSync(release)) {
      completed = true;
      complete(false);
      return;
    }
    if (Date.now() >= deadline) process.exit(91);
    setTimeout(poll, 10);
  };
}

if (kind === 'pi') {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line);
      const response = {
        type: 'response', id: request.id, success: true,
        ...(request.type === 'get_state' ? { data: { sessionId: 'xhigh-linux-session' } } : {}),
      };
      process.stdout.write(`${JSON.stringify(response)}\n`);
      if (request.type === 'prompt') {
        waitForRelease(failed => {
          if (failed) {
            process.stdout.write(`${JSON.stringify({ type: 'error', message: 'xhigh pi operation failure' })}\n`);
            process.exitCode = 23;
            return;
          }
          process.stdout.write(`${JSON.stringify({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: '{"stories":[]}' },
          })}\n`);
          process.stdout.write(`${JSON.stringify({
            type: 'turn_end', message: { usage: { input: 1, output: 2 } },
          })}\n`);
        });
      }
    }
  });
  process.stdin.resume();
} else {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { stdin += chunk; });
  process.stdin.on('end', () => {
    waitForRelease(failed => {
      if (failed) {
        process.stderr.write(`xhigh ${kind} operation failure\n`);
        process.exit(23);
      }
      if (kind === 'claude') {
        process.stdout.write('{"result":"xhigh-claude-ok","input_tokens":1,"output_tokens":2}\n');
      } else if (kind === 'codex') {
        const outputIndex = args.indexOf('--output-last-message');
        if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(92);
        fs.writeFileSync(args[outputIndex + 1], '{"stories":[]}\n', { mode: 0o600 });
        process.stdout.write('{"usage":{"input_tokens":1,"output_tokens":2}}\n');
      } else {
        process.stdout.write(`${JSON.stringify({
          type: 'assistant',
          content: '{"stories":[{"id":"US-001","title":"X-High Linux","description":"Real launcher and bwrap seam","acceptanceCriteria":["Operation completes"],"dependsOn":[]}]}',
        })}\n`);
      }
      void stdin;
    });
  });
  process.stdin.resume();
}
