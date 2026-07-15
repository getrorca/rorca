#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function usage(code = 0) {
  console.log(`Usage: node scripts/monitor-always-on-context.mjs [options]

Options:
  --workspace-id <id>     Workspace to monitor (default: rorca)
  --root <path>           Workspace checkout (default: this checkout)
  --api-base-url <url>    Rorca API (default: http://127.0.0.1:3030)
  --window-hours <n>      Failed-job/audit window, 1-720 (default: 24)
  --token-path <path>     MCP Bearer token file (default: ~/.rorca/mcp-token)
  --json                  Emit the complete machine-readable report
  --allow-degraded        Exit 0 even when checks are degraded
  --help                  Show this help

The default exit code is 0 only when every production check is healthy.`);
  process.exit(code);
}

function parseArgs(argv) {
  const result = {
    workspaceId: 'rorca',
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    apiBaseUrl: 'http://127.0.0.1:3030',
    windowHours: 24,
    tokenPath: path.join(os.homedir(), '.rorca', 'mcp-token'),
    json: false,
    allowDegraded: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace-id') result.workspaceId = argv[++i] || '';
    else if (arg === '--root') result.root = path.resolve(argv[++i] || '');
    else if (arg === '--api-base-url') result.apiBaseUrl = (argv[++i] || '').replace(/\/$/, '');
    else if (arg === '--window-hours') result.windowHours = Number(argv[++i]);
    else if (arg === '--token-path') result.tokenPath = path.resolve(argv[++i] || '');
    else if (arg === '--json') result.json = true;
    else if (arg === '--allow-degraded') result.allowDegraded = true;
    else if (arg === '--help' || arg === '-h') usage();
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!result.workspaceId.trim()) throw new Error('--workspace-id must not be empty');
  if (!result.apiBaseUrl.startsWith('http://') && !result.apiBaseUrl.startsWith('https://')) throw new Error('--api-base-url must be an HTTP(S) URL');
  if (!Number.isInteger(result.windowHours) || result.windowHours < 1 || result.windowHours > 720) throw new Error('--window-hours must be an integer between 1 and 720');
  return result;
}

function projectSlug(root) {
  return path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'rorca';
}

function launchdStatus(label) {
  if (process.platform !== 'darwin') return { manager: 'unsupported', label, loaded: null, state: 'unknown', pid: null };
  const target = `gui/${process.getuid()}/${label}`;
  const result = spawnSync('launchctl', ['print', target], { encoding: 'utf8' });
  if (result.status !== 0) return { manager: 'launchd', label, loaded: false, state: 'not-loaded', pid: null };
  const output = result.stdout || '';
  const state = output.match(/^\s*state = (.+)$/m)?.[1]?.trim() || 'unknown';
  const pid = Number(output.match(/^\s*pid = (\d+)$/m)?.[1]);
  return { manager: 'launchd', label, loaded: true, state, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
}

function ageSeconds(value) {
  if (typeof value !== 'string' || !value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((Date.now() - timestamp) / 1000)) : null;
}

function localCaptureStatus(root) {
  const statusPath = path.join(root, '.rorca', 'capture', 'status.json');
  if (!existsSync(statusPath)) return { available: false, statusPath, error: 'status_file_missing' };
  try {
    const value = JSON.parse(readFileSync(statusPath, 'utf8'));
    const scanIntervalMs = Number(value?.resourceBounds?.scanIntervalMs) || 60_000;
    const freshnessThresholdSeconds = Math.max(180, Math.ceil(scanIntervalMs * 3 / 1000));
    return {
      available: true,
      statusPath,
      lastSeen: value?.last_seen ?? null,
      lastFlush: value?.lastFlush ?? null,
      lastScan: value?.lastScan ?? null,
      seenAgeSeconds: ageSeconds(value?.last_seen),
      flushAgeSeconds: ageSeconds(value?.lastFlush),
      queueDepth: Number(value?.queueDepth) || 0,
      backoffMs: Number(value?.backoffMs) || 0,
      queueWarnSize: Number(value?.resourceBounds?.queueWarnSize) || 100,
      freshnessThresholdSeconds,
      policyMode: value?.capturePolicy?.mode ?? value?.capturePolicy?.policyMode ?? null,
      paused: value?.capturePolicy?.paused === true,
      processHealth: value?.processHealth ?? null,
      sourceCapabilities: value?.sourceCapabilities ?? null,
    };
  } catch {
    return { available: false, statusPath, error: 'status_file_invalid' };
  }
}

async function apiMonitoring(options) {
  const url = `${options.apiBaseUrl}/api/context-capture/${encodeURIComponent(options.workspaceId)}/monitoring?windowHours=${options.windowHours}`;
  if (!existsSync(options.tokenPath)) return { available: false, url, error: 'mcp_token_missing', tokenPath: options.tokenPath };
  const token = readFileSync(options.tokenPath, 'utf8').trim();
  if (!token) return { available: false, url, error: 'mcp_token_empty', tokenPath: options.tokenPath };
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* stale servers may return an HTML fallback */ }
    if (!response.ok) return { available: false, url, statusCode: response.status, error: body?.error || `http_${response.status}` };
    if (!body || typeof body !== 'object') return { available: false, url, statusCode: response.status, error: 'invalid_json_response' };
    return { available: true, url, body };
  } catch (error) {
    return { available: false, url, error: error instanceof Error ? error.message : String(error) };
  }
}

function evaluate(report) {
  const reasons = [];
  const local = report.capture;
  if (!local.available) reasons.push(local.error || 'capture_status_unavailable');
  else {
    if (local.processHealth?.running !== true) reasons.push('capture_service_not_running');
    if (local.seenAgeSeconds === null || local.seenAgeSeconds > local.freshnessThresholdSeconds) reasons.push('capture_last_seen_stale');
    if (local.queueDepth >= local.queueWarnSize) reasons.push('capture_offline_queue_high');
    if (local.queueDepth > 0 && (local.flushAgeSeconds === null || local.flushAgeSeconds > local.freshnessThresholdSeconds)) reasons.push('capture_last_flush_stale');
    if (local.backoffMs > 0) reasons.push('capture_api_backoff_active');
    if (local.paused) reasons.push('capture_paused');
  }

  if (!report.api.available) reasons.push('capture_monitoring_api_unavailable');
  else {
    const value = report.api.body;
    if (value.status !== 'healthy') reasons.push(...(Array.isArray(value.reasons) && value.reasons.length ? value.reasons : ['capture_monitoring_degraded']));
    if (Number(value?.queues?.capture?.depth) > 0) reasons.push('capture_queue_not_empty');
    if (Number(value?.queues?.capture?.failed) > 0) reasons.push('capture_jobs_failed');
    if (Number(value?.queues?.distillation?.failed) > 0) reasons.push('distillation_jobs_failed');
    if (Number(value?.distillation?.activeErrors ?? value?.distillation?.errors) > 0) reasons.push('distillation_events_error');
  }

  for (const [name, service] of Object.entries(report.managedServices)) {
    if (service.manager === 'launchd' && (!service.loaded || service.state !== 'running')) reasons.push(`managed_${name}_not_running`);
  }
  return [...new Set(reasons)];
}

function printText(report) {
  console.log(`Always-On Context: ${report.status.toUpperCase()} (${report.workspaceId})`);
  console.log(`capture last_seen=${report.capture.lastSeen ?? 'n/a'} lastFlush=${report.capture.lastFlush ?? 'n/a'} offlineQueue=${report.capture.queueDepth ?? 'n/a'} backoffMs=${report.capture.backoffMs ?? 'n/a'}`);
  if (report.api.available) {
    const body = report.api.body;
    console.log(`pg-boss captureDepth=${body.queues?.capture?.depth ?? 'n/a'} captureFailed=${body.queues?.capture?.failed ?? 'n/a'} distillDepth=${body.queues?.distillation?.depth ?? 'n/a'} distillFailed=${body.queues?.distillation?.failed ?? 'n/a'}`);
    console.log(`distillation errors=${body.distillation?.errors ?? 'n/a'} active=${body.distillation?.activeErrors ?? 'n/a'} acceptedHistorical=${body.distillation?.acceptedHistoricalErrors ?? 'n/a'} pending=${body.distillation?.pending ?? 'n/a'} auditEvents=${body.audit?.events ?? 'n/a'} redactions=${body.audit?.redactions ?? 'n/a'} ignoredPaths=${body.audit?.ignoredPaths ?? 'n/a'}`);
    if (Array.isArray(body.advisories) && body.advisories.length) console.log(`advisories: ${body.advisories.join(', ')}`);
  } else {
    console.log(`monitoring API unavailable: ${report.api.error}`);
  }
  for (const [name, service] of Object.entries(report.managedServices)) console.log(`${name} manager=${service.manager} state=${service.state} pid=${service.pid ?? 'n/a'}`);
  if (report.reasons.length) console.log(`reasons: ${report.reasons.join(', ')}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const slug = projectSlug(options.root);
  const report = {
    generatedAt: new Date().toISOString(),
    workspaceId: options.workspaceId,
    root: options.root,
    windowHours: options.windowHours,
    capture: localCaptureStatus(options.root),
    api: await apiMonitoring(options),
    managedServices: {
      backend: launchdStatus(`com.rorca.backend.${slug}`),
      worker: launchdStatus(`com.rorca.worker.${slug}`),
      capture: launchdStatus(`com.rorca.capture.${options.workspaceId}`),
    },
    status: 'unknown',
    reasons: [],
  };
  report.reasons = evaluate(report);
  report.status = report.reasons.length === 0 ? 'healthy' : 'degraded';
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printText(report);
  if (report.status !== 'healthy' && !options.allowDegraded) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[always-on-monitor] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
