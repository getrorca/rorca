// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const monitorScript = path.join(checkout, 'scripts', 'monitor-always-on-context.mjs');
const managerScript = path.join(checkout, 'scripts', 'manage-always-on-monitor.mjs');

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rorca-monitor-'));
  await mkdir(path.join(root, '.rorca', 'capture'), { recursive: true });
  await mkdir(path.join(root, '.rorca', 'services'), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(path.join(root, '.rorca', 'capture', 'status.json'), JSON.stringify({
    last_seen: now,
    lastFlush: now,
    lastScan: now,
    queueDepth: 0,
    backoffMs: 0,
    processHealth: { running: true },
    capturePolicy: { paused: false },
    resourceBounds: { scanIntervalMs: 60_000, queueWarnSize: 100 },
    capturedPayload: 'MUST_NOT_LEAK',
  }));
  return root;
}

async function mockApi(body) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('monitor persists only the count/status contract and spools a local classified alert', async () => {
  const root = await tempRoot();
  const statusFile = path.join(root, '.rorca', 'services', 'status.json');
  const alertsFile = path.join(root, '.rorca', 'services', 'alerts.ndjson');
  const api = await mockApi({
    status: 'degraded',
    reasons: ['raw command: rm -rf / SECRET_TOKEN'],
    queues: {
      capture: { depth: 2, failed: 1, payload: 'MUST_NOT_LEAK' },
      distillation: { depth: 3, failed: 1 },
    },
    distillation: { errors: 1, activeErrors: 1, acceptedHistoricalErrors: 0, pending: 3, rawError: 'DATABASE_PASSWORD' },
    audit: { events: 4, redactions: 5, ignoredPaths: 6 },
  });
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      monitorScript,
      '--root', root,
      '--workspace-id', 'test-workspace',
      '--api-base-url', api.url,
      '--status-file', statusFile,
      '--alert-events-file', alertsFile,
      '--allow-degraded',
      '--json',
    ]);
    assert.equal(stderr, '');
    const report = JSON.parse(stdout);
    assert.equal(report.api.queues.capture.depth, 2);
    assert.equal(report.api.distillation.activeErrors, 1);
    assert.ok(report.reasonCodes.includes('capture_jobs_failed'));

    const persisted = await readFile(statusFile, 'utf8');
    const alerts = await readFile(alertsFile, 'utf8');
    for (const forbidden of ['MUST_NOT_LEAK', 'SECRET_TOKEN', 'DATABASE_PASSWORD', 'rm -rf', 'raw command']) {
      assert.equal(stdout.includes(forbidden), false);
      assert.equal(persisted.includes(forbidden), false);
      assert.equal(alerts.includes(forbidden), false);
    }
    const alert = JSON.parse(alerts.trim());
    assert.deepEqual(Object.keys(alert.counts).sort(), [
      'activeDistillationErrors',
      'captureFailed',
      'captureQueueDepth',
      'distillationFailed',
      'distillationQueueDepth',
      'localQueueDepth',
      'logRotationBlocked',
    ]);
  } finally {
    await api.close();
  }
});

test('monitor fails closed to classified local status when the API is unreachable', async () => {
  const root = await tempRoot();
  const statusFile = path.join(root, '.rorca', 'services', 'status.json');
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  await assert.rejects(execFileAsync(process.execPath, [
    monitorScript,
    '--root', root,
    '--workspace-id', 'test-workspace',
    '--api-base-url', `http://127.0.0.1:${address.port}`,
    '--status-file', statusFile,
    '--alert-sink', 'none',
    '--json',
  ]), (error) => {
    assert.equal(error.code, 1);
    return true;
  });

  const report = JSON.parse(await readFile(statusFile, 'utf8'));
  assert.equal(report.status, 'degraded');
  assert.ok(report.reasonCodes.includes('capture_monitoring_api_unreachable'));
  assert.equal(JSON.stringify(report).includes(`127.0.0.1:${address.port}`), false);
});

test('managed schedule render is deterministic, valid, and does not load launchd', async () => {
  const plistDir = await mkdtemp(path.join(os.tmpdir(), 'rorca-monitor-plist-'));
  const args = [
    managerScript,
    'render',
    '--root', checkout,
    '--workspace-id', 'test-workspace',
    '--plist-dir', plistDir,
    '--interval', '300',
  ];
  await execFileAsync(process.execPath, args);
  const plist = path.join(plistDir, `com.rorca.monitor.${path.basename(checkout)}.test-workspace.plist`);
  const first = await readFile(plist, 'utf8');
  await execFileAsync(process.execPath, args);
  const second = await readFile(plist, 'utf8');

  assert.equal(first, second);
  assert.match(first, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(first, /--rotate-logs/);
  assert.match(first, /--require-managed-schedule/);
  assert.doesNotMatch(first, /token|password|secret/i);
  await chmod(plist, 0o644);
});
