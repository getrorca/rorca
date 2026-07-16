#!/usr/bin/env node
// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maintainManagedLogs } from './lib/log-retention.mjs';

const SCHEMA_VERSION = 1;
const ALERT_REMINDER_MS = 15 * 60 * 1000;

function usage(code = 0) {
  console.log(`Usage: node scripts/monitor-always-on-context.mjs [options]

Options:
  --workspace-id <id>       Workspace to monitor (default: rorca)
  --root <path>             Workspace checkout (default: this checkout)
  --api-base-url <url>      Rorca API (default: http://127.0.0.1:3030)
  --window-hours <n>        Failed-job/audit window, 1-720 (default: 24)
  --token-path <path>       MCP Bearer token file (default: ~/.rorca/mcp-token)
  --status-file <path>      Atomic local status output
  --alert-sink <kind>       none or local-file (default: local-file)
  --alert-events-file <p>   Privacy-safe local alert event spool
  --rotate-logs             Apply managed log retention before checks
  --require-managed-schedule  Require the monitor LaunchAgent to be running
  --json                    Emit one machine-readable JSON record
  --allow-degraded          Exit 0 even when checks are degraded
  --help                    Show this help

Only the local-file alert sink is implemented. External delivery requires a
separate reviewed adapter consuming the versioned privacy-safe event contract.`);
  process.exit(code);
}

function parseArgs(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = {
    workspaceId: 'rorca',
    root,
    apiBaseUrl: 'http://127.0.0.1:3030',
    windowHours: 24,
    tokenPath: path.join(os.homedir(), '.rorca', 'mcp-token'),
    json: false,
    allowDegraded: false,
    rotateLogs: false,
    requireManagedSchedule: false,
    alertSink: 'local-file',
    statusFile: null,
    alertEventsFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace-id') result.workspaceId = argv[++i] || '';
    else if (arg === '--root') result.root = path.resolve(argv[++i] || '');
    else if (arg === '--api-base-url') result.apiBaseUrl = (argv[++i] || '').replace(/\/$/, '');
    else if (arg === '--window-hours') result.windowHours = Number(argv[++i]);
    else if (arg === '--token-path') result.tokenPath = path.resolve(argv[++i] || '');
    else if (arg === '--status-file') result.statusFile = path.resolve(argv[++i] || '');
    else if (arg === '--alert-sink') result.alertSink = argv[++i] || '';
    else if (arg === '--alert-events-file') result.alertEventsFile = path.resolve(argv[++i] || '');
    else if (arg === '--rotate-logs') result.rotateLogs = true;
    else if (arg === '--require-managed-schedule') result.requireManagedSchedule = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--allow-degraded') result.allowDegraded = true;
    else if (arg === '--help' || arg === '-h') usage();
    else throw new Error('invalid_arguments');
  }
  if (!result.workspaceId.trim() || !/^[a-zA-Z0-9._-]+$/.test(result.workspaceId)) throw new Error('invalid_workspace_id');
  if (!result.apiBaseUrl.startsWith('http://') && !result.apiBaseUrl.startsWith('https://')) throw new Error('invalid_api_url');
  if (!Number.isInteger(result.windowHours) || result.windowHours < 1 || result.windowHours > 720) throw new Error('invalid_window_hours');
  if (!['none', 'local-file'].includes(result.alertSink)) throw new Error('unsupported_alert_sink');
  result.statusFile ??= path.join(result.root, '.rorca', 'services', 'always-on-monitor-status.json');
  result.alertEventsFile ??= path.join(result.root, '.rorca', 'services', 'always-on-alerts.ndjson');
  return result;
}

function projectSlug(root) {
  return path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'rorca';
}

function launchdStatus(label) {
  if (process.platform !== 'darwin') return { manager: 'unsupported', loaded: null, state: 'unknown' };
  const target = `gui/${process.getuid()}/${label}`;
  const result = spawnSync('launchctl', ['print', target], { encoding: 'utf8' });
  if (result.status !== 0) return { manager: 'launchd', loaded: false, state: 'not-loaded' };
  const state = (result.stdout || '').match(/^\s*state = (.+)$/m)?.[1]?.trim();
  return { manager: 'launchd', loaded: true, state: state === 'running' ? 'running' : 'stopped' };
}

function ageSeconds(value) {
  if (typeof value !== 'string' || !value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((Date.now() - timestamp) / 1000)) : null;
}

function localCaptureStatus(root) {
  const statusPath = path.join(root, '.rorca', 'capture', 'status.json');
  if (!existsSync(statusPath)) return { available: false, errorCode: 'status_file_missing' };
  try {
    const value = JSON.parse(readFileSync(statusPath, 'utf8'));
    const scanIntervalMs = Number(value?.resourceBounds?.scanIntervalMs) || 60_000;
    return {
      available: true,
      running: value?.processHealth?.running === true,
      seenAgeSeconds: ageSeconds(value?.last_seen),
      flushAgeSeconds: ageSeconds(value?.lastFlush),
      scanAgeSeconds: ageSeconds(value?.lastScan),
      queueDepth: Math.max(0, Number(value?.queueDepth) || 0),
      backoffMs: Math.max(0, Number(value?.backoffMs) || 0),
      queueWarnSize: Math.max(1, Number(value?.resourceBounds?.queueWarnSize) || 100),
      freshnessThresholdSeconds: Math.max(180, Math.ceil(scanIntervalMs * 3 / 1000)),
      paused: value?.capturePolicy?.paused === true,
    };
  } catch {
    return { available: false, errorCode: 'status_file_invalid' };
  }
}

function nonNegativeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

async function apiMonitoring(options) {
  const url = `${options.apiBaseUrl}/api/context-capture/${encodeURIComponent(options.workspaceId)}/monitoring?windowHours=${options.windowHours}`;
  if (!existsSync(options.tokenPath)) return { available: false, url, error: 'mcp_token_missing', tokenPath: options.tokenPath };
  const token = readFileSync(options.tokenPath, 'utf8').trim();
  if (!token) return { available: false, url, error: 'mcp_token_empty', tokenPath: options.tokenPath };
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    let body = null;
    try { body = await response.json(); } catch { /* classified below */ }
    if (!response.ok) return { available: false, statusCode: response.status, errorCode: 'http_error' };
    if (!body || typeof body !== 'object') return { available: false, statusCode: response.status, errorCode: 'invalid_response' };
    return {
      available: true,
      statusCode: response.status,
      status: body.status === 'healthy' ? 'healthy' : 'degraded',
      queues: {
        capture: {
          depth: nonNegativeCount(body.queues?.capture?.depth),
          failed: nonNegativeCount(body.queues?.capture?.failed),
          oldestPendingAgeSeconds: nonNegativeCount(body.queues?.capture?.oldestPendingAgeSeconds),
        },
        distillation: {
          depth: nonNegativeCount(body.queues?.distillation?.depth),
          failed: nonNegativeCount(body.queues?.distillation?.failed),
          oldestPendingAgeSeconds: nonNegativeCount(body.queues?.distillation?.oldestPendingAgeSeconds),
        },
      },
      distillation: {
        errors: nonNegativeCount(body.distillation?.errors),
        activeErrors: nonNegativeCount(body.distillation?.activeErrors),
        acceptedHistoricalErrors: nonNegativeCount(body.distillation?.acceptedHistoricalErrors),
        pending: nonNegativeCount(body.distillation?.pending),
      },
      audit: {
        events: nonNegativeCount(body.audit?.events),
        redactions: nonNegativeCount(body.audit?.redactions),
        ignoredPaths: nonNegativeCount(body.audit?.ignoredPaths),
      },
    };
  } catch (error) {
    return {
      available: false,
      errorCode: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unreachable',
    };
  }
}

function evaluate(report) {
  const reasons = [];
  const local = report.capture;
  if (!local.available) reasons.push(local.errorCode || 'capture_status_unavailable');
  else {
    if (!local.running) reasons.push('capture_service_not_running');
    if (local.seenAgeSeconds === null || local.seenAgeSeconds > local.freshnessThresholdSeconds) reasons.push('capture_last_seen_stale');
    if (local.queueDepth >= local.queueWarnSize) reasons.push('capture_offline_queue_high');
    if (local.queueDepth > 0 && (local.flushAgeSeconds === null || local.flushAgeSeconds > local.freshnessThresholdSeconds)) reasons.push('capture_last_flush_stale');
    if (local.backoffMs > 0) reasons.push('capture_api_backoff_active');
    if (local.paused) reasons.push('capture_paused');
  }

  if (!report.api.available) reasons.push(`capture_monitoring_api_${report.api.errorCode || 'unavailable'}`);
  else {
    if (report.api.status !== 'healthy') reasons.push('capture_monitoring_degraded');
    if (report.api.queues.capture.depth > 0) reasons.push('capture_queue_not_empty');
    if (report.api.queues.capture.failed > 0) reasons.push('capture_jobs_failed');
    if (report.api.queues.distillation.failed > 0) reasons.push('distillation_jobs_failed');
    if (report.api.distillation.activeErrors > 0) reasons.push('distillation_events_error');
  }

  for (const [name, service] of Object.entries(report.managedServices)) {
    if (service.manager === 'launchd' && (!service.loaded || service.state !== 'running')) reasons.push(`managed_${name}_not_running`);
  }
  if (report.logs.blocked > 0) reasons.push('log_retention_blocked');
  return [...new Set(reasons)].sort();
}

function atomicWriteStatus(file, report) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function previousStatus(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return {
      status: value?.status ?? 'unknown',
      lastAlertAt: typeof value?.lastAlertAt === 'string' ? value.lastAlertAt : null,
    };
  } catch {
    return { status: 'unknown', lastAlertAt: null };
  }
}

function alertCounts(report) {
  return {
    localQueueDepth: report.capture.queueDepth ?? 0,
    captureQueueDepth: report.api.queues?.capture?.depth ?? 0,
    captureFailed: report.api.queues?.capture?.failed ?? 0,
    distillationQueueDepth: report.api.queues?.distillation?.depth ?? 0,
    distillationFailed: report.api.queues?.distillation?.failed ?? 0,
    activeDistillationErrors: report.api.distillation?.activeErrors ?? 0,
    logRotationBlocked: report.logs.blocked,
  };
}

function maybeWriteAlert(options, report, previous) {
  if (options.alertSink === 'none') return null;
  const lastAlertMs = previous.lastAlertAt ? new Date(previous.lastAlertAt).getTime() : 0;
  const changed = previous.status !== report.status;
  const reminderDue = report.status === 'degraded' && (!Number.isFinite(lastAlertMs) || Date.now() - lastAlertMs >= ALERT_REMINDER_MS);
  if (!changed && !reminderDue) return previous.lastAlertAt;
  if (report.status === 'healthy' && previous.status === 'unknown') return null;

  const event = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'rorca.always_on.health',
    observedAt: report.generatedAt,
    state: report.status,
    previousState: previous.status,
    severity: report.status === 'healthy' ? 'recovery' : 'critical',
    reasonCodes: report.reasonCodes,
    counts: alertCounts(report),
  };
  mkdirSync(path.dirname(options.alertEventsFile), { recursive: true });
  appendFileSync(options.alertEventsFile, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(options.alertEventsFile, 0o600);
  return report.generatedAt;
}

function printText(report) {
  console.log(`Always-On Context: ${report.status.toUpperCase()} (${report.workspaceId})`);
  console.log(`capture available=${report.capture.available} running=${report.capture.running ?? false} seenAgeSeconds=${report.capture.seenAgeSeconds ?? -1} queueDepth=${report.capture.queueDepth ?? 0} backoffMs=${report.capture.backoffMs ?? 0}`);
  console.log(`api available=${report.api.available} captureDepth=${report.api.queues?.capture?.depth ?? 0} captureFailed=${report.api.queues?.capture?.failed ?? 0} distillDepth=${report.api.queues?.distillation?.depth ?? 0} distillFailed=${report.api.queues?.distillation?.failed ?? 0}`);
  console.log(`logs checked=${report.logs.checked} rotated=${report.logs.rotated} removed=${report.logs.removed} blocked=${report.logs.blocked}`);
  if (report.reasonCodes.length) console.log(`reasonCodes=${report.reasonCodes.join(',')}`);
}

let parsedOptions = null;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  parsedOptions = options;
  const slug = projectSlug(options.root);
  const previous = previousStatus(options.statusFile);
  const logs = options.rotateLogs
    ? await maintainManagedLogs(options.root)
    : { checked: 0, rotated: 0, removed: 0, blocked: 0 };
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    workspaceId: options.workspaceId,
    windowHours: options.windowHours,
    status: 'unknown',
    reasonCodes: [],
    capture: localCaptureStatus(options.root),
    api: await apiMonitoring(options),
    managedServices: {
      backend: launchdStatus(`com.rorca.backend.${slug}`),
      worker: launchdStatus(`com.rorca.worker.${slug}`),
      capture: launchdStatus(`com.rorca.capture.${options.workspaceId}`),
      ...(options.requireManagedSchedule ? { monitor: launchdStatus(`com.rorca.monitor.${slug}.${options.workspaceId}`) } : {}),
    },
    logs: {
      checked: logs.checked,
      rotated: logs.rotated,
      removed: logs.removed,
      blocked: logs.blocked,
    },
    lastAlertAt: previous.lastAlertAt,
  };
  report.reasonCodes = evaluate(report);
  report.status = report.reasonCodes.length === 0 ? 'healthy' : 'degraded';
  report.lastAlertAt = maybeWriteAlert(options, report, previous);
  atomicWriteStatus(options.statusFile, report);
  if (options.json) console.log(JSON.stringify(report));
  else printText(report);
  if (report.status !== 'healthy' && !options.allowDegraded) process.exitCode = 1;
}

main().catch(() => {
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    status: 'unknown',
    reasonCodes: ['monitor_internal_error'],
  };
  if (parsedOptions?.statusFile) {
    try { atomicWriteStatus(parsedOptions.statusFile, report); } catch { /* stderr remains classified */ }
  }
  console.error('[always-on-monitor] monitor_internal_error');
  process.exitCode = 2;
});
