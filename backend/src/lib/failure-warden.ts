/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * failure-warden.ts — Hermes failure warden for Rorca pipeline runs.
 *
 * The invariant: a failed run is a ticket, never a tombstone. The warden runs
 * inside the worker (the process that already owns run execution), so it
 * operates even when no Pi/UI session is attached. It sweeps runs that
 * terminalized as failed, classifies the root cause against a fixed taxonomy,
 * applies the smallest safe fix, and re-drives through the SAME governed API
 * paths a human would use (retry / trigger). Everything else escalates with an
 * exact operator action. Nothing is ever left failed silently.
 *
 * The warden is deliberately NOT an LLM: classification is deterministic
 * signature matching, re-drive is bounded per run, and authority always
 * resolves through the API routes (preview binding, dispatch identity, pass
 * reconciliation all still apply). A run is re-driven at most
 * RORCA_FAILURE_WARDEN_MAX_AUTO_REDRIVES times; further failures escalate.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeRunAgentType } from './run-metadata';

// ── Taxonomy ────────────────────────────────────────────────────────────────

export type WardenFailureClass =
  | 'dispatch_shape' // e.g. linux_bwrap_required_for_requested_mode on macOS (non-Pi agent)
  | 'egress_blocked' // model host missing from RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS
  | 'quota_exhausted' // provider rate limit / usage cap
  | 'envelope_conflict' // stale generation / payload drift / cancellation fence / spec revision mismatch
  | 'progress_log' // pi_progress_log_outside_workspace / unverified
  | 'code_bug' // known defect fixed in current code (text=uuid, expireIn clamp)
  | 'runtime_root' // ordinary-local-Pi runtime root removed mid-run (sweep liveness)
  | 'closeout_pending' // retry scope passed but governed integration closeout did not finalize
  | 'zombie_loop' // orphan sweep, stuck running, or respawn loop
  | 'stuck_stage' // spec workflow stage stuck pending
  | 'timeout' // authoritative story timeout or PTY idle timeout
  | 'unknown';

export type WardenAction =
  | 'none'
  | 're-drive-retry' // POST /api/pipeline/runs/:id/retry (rerunFromScratch)
  | 're-trigger-corrected' // POST /api/pipeline/trigger with corrected dispatch shape
  | 'escalate'; // ledger + WAL event + exact operator action

const SIGNATURES: Array<{ class: WardenFailureClass; patterns: RegExp[] }> = [
  {
    class: 'dispatch_shape',
    patterns: [/linux_bwrap_required_for_requested_mode/i],
  },
  {
    class: 'egress_blocked',
    patterns: [/connection error\./i, /fetch failed/i, /eai_again/i, /enotfound/i, /egress/i, /network error/i, /tunnel connection failed/i],
  },
  {
    class: 'quota_exhausted',
    patterns: [/rate.?limit/i, /usage limit/i, /quota/i, /insufficient_quota/i, /429\b/i, /billing/i],
  },
  {
    class: 'envelope_conflict',
    patterns: [/stale_generation/i, /payload_changed/i, /cancellation_fence_mismatch/i, /launch generation/i, /attempt envelope/i, /spec_revision_mismatch/i],
  },
  {
    class: 'runtime_root',
    patterns: [/ordinary-local-pi-runtime/i, /lstat.*runtime root/i],
  },
  {
    class: 'progress_log',
    patterns: [/pi_progress_log_outside_workspace/i, /pi_progress_log_unverified/i],
  },
  {
    class: 'code_bug',
    patterns: [/text\s*=\s*uuid/i, /42883/i, /expirein cannot exceed 24 hours/i, /boss_job_id/i],
  },
  {
    class: 'closeout_pending',
    patterns: [/retry_integration_pending/i],
  },
  {
    class: 'zombie_loop',
    patterns: [/orphan_sweep/i, /orphan swept/i, /heartbeat.*stale/i],
  },
  {
    class: 'stuck_stage',
    patterns: [/pending_enrichment/i, /workflow.*stuck/i, /stage.*reconcile/i, /queued forever/i],
  },
];

const EGRESS_HOSTS_REQUIRED = ['api.openai.com', 'chatgpt.com', 'api.deepseek.com'];

// ── Ledger ──────────────────────────────────────────────────────────────────

export interface WardenLedgerEntry {
  at: string;
  runId: number;
  classification: WardenFailureClass;
  action: WardenAction;
  detail: string;
  outcome: 'planned' | 'ok' | 'failed' | 'skipped';
}

export function wardenLedgerDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RORCA_HERMES_REPAIR_HOME ?? path.join(os.homedir(), '.rorca', 'hermes-repair');
}

function ledgerFile(runId: number, dir: string): string {
  return path.join(dir, `run-${runId}.jsonl`);
}

export async function readWardenLedger(runId: number, env: NodeJS.ProcessEnv = process.env): Promise<WardenLedgerEntry[]> {
  const file = ledgerFile(runId, wardenLedgerDir(env));
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as WardenLedgerEntry);
  } catch {
    return [];
  }
}

export async function appendWardenLedger(entry: WardenLedgerEntry, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = wardenLedgerDir(env);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.appendFile(ledgerFile(entry.runId, dir), JSON.stringify(entry) + '\n', 'utf8');
}

// ── Classification ──────────────────────────────────────────────────────────

export interface FailedRunRow {
  id: number;
  workspace_id: number | string;
  spec_path: string | null;
  summary: string | null;
  status: string;
  finished_at: Date | string | null;
  terminal_reason?: string | null;
  agent_type?: string | null;
  agent?: string | null;
}

export function classifyFailure(run: FailedRunRow, evidenceTail: string): WardenFailureClass {
  const terminalReason = run.terminal_reason?.trim().toLowerCase();
  if (terminalReason === 'timeout' || terminalReason === 'idle_timeout' || terminalReason === 'story_timeout') {
    return 'timeout';
  }
  if (run.summary?.trim().toLowerCase().startsWith('retry_integration_pending:')) {
    return 'closeout_pending';
  }
  const haystack = `${run.summary ?? ''}\n${evidenceTail}`;
  // The run's output can mention earlier transient conditions (e.g. a quota
  // notice on a previous attempt) alongside the terminal error. The error
  // nearest the end of the evidence is what actually killed the run, so pick
  // the signature whose latest match sits deepest in the evidence. Ties break
  // to the first signature in taxonomy order.
  let bestClass: WardenFailureClass = 'unknown';
  let bestIndex = -1;
  for (const { class: cls, patterns } of SIGNATURES) {
    let latest = -1;
    for (const pattern of patterns) {
      const matches = [...haystack.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'))];
      for (const match of matches) {
        if (match.index !== undefined && match.index > latest) latest = match.index;
      }
    }
    if (latest > bestIndex) {
      bestIndex = latest;
      bestClass = cls;
    }
  }
  return bestClass;
}

export function decodeChunkTail(chunks: Array<{ chunk: Buffer | Uint8Array | string }>, maxBytes = 16_384): string {
  const parts: string[] = [];
  let total = 0;
  for (const row of chunks) {
    const buf = typeof row.chunk === 'string' ? Buffer.from(row.chunk, 'hex') : Buffer.from(row.chunk);
    total += buf.length;
    if (total > maxBytes) break;
    parts.push(buf.toString('utf8'));
  }
  return parts.reverse().join('\n').slice(-maxBytes);
}

// ── Warden sweep ────────────────────────────────────────────────────────────

export interface FailureWardenDeps {
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  emitWalEvent: (eventType: string, workspaceId: number | string, payload: Record<string, unknown>) => Promise<void>;
  apiBaseUrl: string;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  fetchImpl?: typeof fetch;
}

export interface WardenSweepResult {
  scanned: number;
  acted: number;
  actions: Array<{ runId: number; classification: WardenFailureClass; action: WardenAction }>;
}

const MAX_AUTO_REDRIVES_DEFAULT = 2;
const CANDIDATE_WINDOW_MINUTES_DEFAULT = 24 * 60;

function maxAutoRedrives(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RORCA_FAILURE_WARDEN_MAX_AUTO_REDRIVES);
  return Number.isFinite(raw) && raw >= 0 ? raw : MAX_AUTO_REDRIVES_DEFAULT;
}

function candidateWindowMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RORCA_FAILURE_WARDEN_CANDIDATE_WINDOW_MINUTES);
  return Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : CANDIDATE_WINDOW_MINUTES_DEFAULT;
}

async function postJson(deps: FailureWardenDeps, url: string, body: unknown): Promise<{ ok: boolean; status: number; text: string; fullText?: string }> {
  const fetcher = deps.fetchImpl ?? fetch;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text: text.slice(0, 2_000), fullText: text };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, status: 0, text: err instanceof Error ? err.message : String(err) };
  }
}

async function reDriveRetry(deps: FailureWardenDeps, runId: number): Promise<{ ok: boolean; detail: string; pendingApproval?: boolean }> {
  const url = `${deps.apiBaseUrl}/api/pipeline/runs/${runId}/retry`;
  const request = { forceSequential: true };
  const previewResult = await postJson(deps, url, request);
  if (!previewResult.ok) {
    return { ok: false, detail: `retry preview API ${previewResult.status}: ${previewResult.text}` };
  }

  let parsed: {
    preview?: Record<string, unknown> & { requiresApproval?: boolean; previewHash?: string };
    previewIdentity?: Record<string, unknown>;
  };
  try {
    parsed = JSON.parse(previewResult.fullText ?? previewResult.text) as typeof parsed;
  } catch {
    return { ok: false, detail: 'retry preview API returned malformed JSON' };
  }

  if (parsed.preview?.requiresApproval === true) {
    return {
      ok: false,
      pendingApproval: true,
      detail: 'retry prepared but gated on human approval (retry-preview requiresApproval). Operator: review the preview and approve or cancel it via the retry approval flow.',
    };
  }
  if (!parsed.preview?.previewHash || !parsed.previewIdentity) {
    return { ok: false, detail: 'retry preview API omitted the exact preview packet or identity; no dispatch attempted' };
  }

  const dispatchResult = await postJson(deps, url, {
    ...request,
    previewHash: parsed.preview.previewHash,
    approvedPreview: parsed.preview,
    previewIdentity: parsed.previewIdentity,
  });
  return {
    ok: dispatchResult.ok,
    detail: `retry dispatch API ${dispatchResult.status}: ${dispatchResult.text}`,
  };
}

async function reTriggerCorrected(deps: FailureWardenDeps, run: FailedRunRow): Promise<{ ok: boolean; detail: string }> {
  if (!run.spec_path) return { ok: false, detail: 'run has no spec_path; cannot re-trigger' };
  const result = await postJson(deps, `${deps.apiBaseUrl}/api/pipeline/trigger`, {
    workspaceId: run.workspace_id,
    specPath: run.spec_path,
    agentOverride: normalizeRunAgentType(run.agent_type ?? run.agent) === 'unknown'
      ? 'pi'
      : normalizeRunAgentType(run.agent_type ?? run.agent),
    forceSequential: true,
    autoWorktree: true,
    autoMerge: false,
    mergeStrategy: 'branch-only',
    terminal_mode: 'ansi-html',
  });
  return { ok: result.ok, detail: `trigger API ${result.status}: ${result.text}` };
}

function egressHostsComplete(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = (env.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return EGRESS_HOSTS_REQUIRED.every((host) => configured.includes(host));
}

function decide(deps: FailureWardenDeps, run: FailedRunRow, cls: WardenFailureClass, priorRedrives: number, env: NodeJS.ProcessEnv): { action: WardenAction; detail: string } {
  switch (cls) {
    case 'timeout':
      if (priorRedrives < maxAutoRedrives(env)) {
        return { action: 're-drive-retry', detail: 'authoritative story timeout; dispatch the smallest governed failed-story retry' };
      }
      return { action: 'escalate', detail: `timeout re-drive budget exhausted (${priorRedrives}/${maxAutoRedrives(env)}); operator must inspect the stalled provider turn` };
    case 'dispatch_shape':
      return { action: 're-trigger-corrected', detail: 'non-Pi dispatch shape on this platform; re-trigger with the sanctioned Pi profile' };
    case 'envelope_conflict':
    case 'zombie_loop':
      if (priorRedrives < maxAutoRedrives(env)) {
        return { action: 're-drive-retry', detail: 're-drive with rerunFromScratch through the governed retry route' };
      }
      return { action: 'escalate', detail: `auto re-drive budget exhausted (${priorRedrives}/${maxAutoRedrives(env)}); operator must decide` };
    case 'runtime_root':
      if (priorRedrives < maxAutoRedrives(env)) {
        return { action: 're-drive-retry', detail: 'ordinary-local-Pi runtime root was removed mid-run (sweep liveness); the root is recreated on next launch, so re-drive' };
      }
      return { action: 'escalate', detail: `runtime-root failures persist after ${priorRedrives} re-drives; operator must decide` };
    case 'closeout_pending':
      if (priorRedrives < maxAutoRedrives(env)) {
        return { action: 're-drive-retry', detail: 'retry integration closeout remained pending; re-drive the remaining governed scope with current worker code' };
      }
      return { action: 'escalate', detail: `closeout re-drive budget exhausted (${priorRedrives}/${maxAutoRedrives(env)}); operator must inspect governed finalization authority` };
    case 'egress_blocked':
      if (egressHostsComplete(env)) {
        if (priorRedrives < maxAutoRedrives(env)) {
          return { action: 're-drive-retry', detail: 'egress allowlist is complete; treating as transient and re-driving' };
        }
        return { action: 'escalate', detail: `egress allowlist is complete but failures persist (${priorRedrives} re-drives); operator must decide` };
      }
      return {
        action: 'escalate',
        detail: `egress allowlist incomplete. Required hosts: ${EGRESS_HOSTS_REQUIRED.join(', ')}. Set RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS and restart the worker.`,
      };
    case 'quota_exhausted':
      return { action: 'escalate', detail: 'provider quota/rate limit. Do NOT auto re-drive (burns quota). Operator: raise the quota, switch provider, or wait for the window, then retry.' };
    case 'progress_log':
      return { action: 'escalate', detail: 'progress log path/unverified failure. Verify the worker runs current code (effectiveCwd progress path fix) and the egress allowlist includes the model host.' };
    case 'code_bug':
      return { action: 'escalate', detail: 'known code defect that current code already fixes (text=uuid cast / expireIn clamp). Restart the worker with current code; if it still fails, escalate with the run evidence.' };
    case 'stuck_stage':
      return { action: 'escalate', detail: 'spec workflow stage stuck. Use the spec workflow reconcile/retry API, or repair the spec and re-trigger.' };
    case 'unknown':
      return { action: 'escalate', detail: 'failure does not match the known taxonomy. Operator: read the run evidence in the ledger and extend the taxonomy or fix by hand.' };
  }
}

export async function wardenSweep(deps: FailureWardenDeps, env: NodeJS.ProcessEnv = process.env): Promise<WardenSweepResult> {
  const result: WardenSweepResult = { scanned: 0, acted: 0, actions: [] };
  const log = deps.logger ?? console;

  const rows = await deps.query<FailedRunRow>(
    `SELECT run.id, run.workspace_id, run.spec_path, run.summary, run.status, run.finished_at,
            run.agent_type, run.agent, terminal.terminal_reason
       FROM pipeline_runs run
       LEFT JOIN LATERAL (
         SELECT event.payload->>'reason' AS terminal_reason
           FROM wal_events event
          WHERE event.canonical_run_id = run.id
            AND event.event_type = 'story_failed'
          ORDER BY event.id DESC
          LIMIT 1
       ) terminal ON TRUE
      WHERE run.status IN ('failed', 'partial_failure')
        AND run.finished_at > NOW() - ($1::int * INTERVAL '1 minute')
      ORDER BY run.finished_at DESC
      LIMIT 50`,
    [candidateWindowMinutes(env)],
  ).catch((err: unknown) => {
    log.warn({ err }, '[failure-warden] candidate query failed');
    return [];
  });

  for (const run of rows) {
    result.scanned += 1;
    const ledger = await readWardenLedger(run.id, env);

    // Evidence tail: last chunks, newest first, decoded.
    const chunks = await deps.query<{ chunk: Buffer }>(
      `SELECT chunk FROM run_output_chunks WHERE run_id = $1 ORDER BY sequence DESC LIMIT 40`,
      [run.id],
    ).catch(() => [] as Array<{ chunk: Buffer }>);
    const evidence = decodeChunkTail(chunks);

    const cls = classifyFailure(run, evidence);
    // Preserve the append-only diagnosis history, but permit current code to
    // supersede an older misclassification when authoritative terminal fields
    // now classify the run differently.
    if (ledger.at(-1)?.classification === cls) continue;
    const priorRedrives = ledger.filter((entry) => entry.action === 're-drive-retry' || entry.action === 're-trigger-corrected').length;
    const { action, detail } = decide(deps, run, cls, priorRedrives, env);

    if (action === 'none') continue;

    // Persist the plan BEFORE acting so a crash mid-action is visible.
    await appendWardenLedger({
      at: new Date().toISOString(),
      runId: run.id,
      classification: cls,
      action,
      detail,
      outcome: 'planned',
    }, env);

    let outcome: WardenLedgerEntry['outcome'] = 'ok';
    let outcomeDetail = detail;
    let pendingApproval = false;
    if (action === 're-drive-retry') {
      const attempt = await reDriveRetry(deps, run.id);
      outcome = attempt.ok ? 'ok' : 'failed';
      outcomeDetail = attempt.detail;
      pendingApproval = attempt.pendingApproval === true;
    } else if (action === 're-trigger-corrected') {
      const attempt = await reTriggerCorrected(deps, run);
      outcome = attempt.ok ? 'ok' : 'failed';
      outcomeDetail = attempt.detail;
    }

    // A prepared-but-unapproved retry is NOT a completed re-drive: escalation
    // carries the human approval action. Treat it as escalated, not redriven.
    const escalated = action === 'escalate' || outcome === 'failed' || pendingApproval;

    if (escalated) {
      await deps.emitWalEvent('run_repair_escalated', run.workspace_id, {
        run_id: run.id,
        classification: cls,
        action,
        detail: outcomeDetail,
        operator_action: outcomeDetail,
      }).catch(() => undefined);
    } else {
      await deps.emitWalEvent('run_repair_redriven', run.workspace_id, {
        run_id: run.id,
        classification: cls,
        action,
        detail: outcomeDetail,
      }).catch(() => undefined);
    }

    await appendWardenLedger({
      at: new Date().toISOString(),
      runId: run.id,
      classification: cls,
      action,
      detail: outcomeDetail,
      outcome,
    }, env);

    result.acted += 1;
    result.actions.push({ runId: run.id, classification: cls, action });
    log.warn({ runId: run.id, classification: cls, action, outcome }, '[failure-warden] acted on failed run');
  }

  return result;
}

// ── Stalled-run escalation (the rogue-respawn case) ─────────────────────────

export interface StalledRunRow {
  id: number;
  workspace_id: number | string;
  started_at: Date | string | null;
  summary: string | null;
}

/**
 * Runs that have been `running` far longer than any legitimate story window
 * (default 4h) are escalated — the orphan sweep cannot catch them because the
 * worker heartbeat may still be fresh (the rogue-daemon respawn case that
 * burned quota for 9.5 hours). The warden does NOT kill or re-drive these;
 * it escalates with evidence so an operator can kill the responsible tree.
 */
export async function wardenEscalateStalledRuns(
  deps: FailureWardenDeps,
  stalledHours = Number(process.env.RORCA_FAILURE_WARDEN_STALL_HOURS ?? 4),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const log = deps.logger ?? console;
  const rows = await deps.query<StalledRunRow>(
    `SELECT id, workspace_id, started_at, summary
     FROM pipeline_runs
     WHERE status = 'running'
       AND started_at < NOW() - INTERVAL '${stalledHours} hours'
     ORDER BY started_at ASC
     LIMIT 20`,
  ).catch((err: unknown) => {
    log.warn({ err }, '[failure-warden] stalled-run query failed');
    return [];
  });

  let escalated = 0;
  for (const run of rows) {
    const ledger = await readWardenLedger(run.id, env);
    if (ledger.some((entry) => entry.action === 'escalate' && entry.classification === 'zombie_loop')) continue;
    await appendWardenLedger({
      at: new Date().toISOString(),
      runId: run.id,
      classification: 'zombie_loop',
      action: 'escalate',
      detail: `run running since ${String(run.started_at)} with no conclusion; worker heartbeat may be fresh (respawn loop). Operator: inspect the owning worker/broker process tree and kill it, then re-drive.`,
      outcome: 'planned',
    }, env);
    await deps.emitWalEvent('run_repair_escalated', run.workspace_id, {
      run_id: run.id,
      classification: 'zombie_loop',
      action: 'escalate',
      detail: `run running since ${String(run.started_at)}; possible respawn loop.`,
    }).catch(() => undefined);
    escalated += 1;
    log.warn({ runId: run.id, startedAt: run.started_at }, '[failure-warden] escalated stalled running run');
  }
  return escalated;
}
