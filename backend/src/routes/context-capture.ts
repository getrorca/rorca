/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { query, queryOne } from '../db/index';
import { NotFoundError, ServiceUnavailableError, ValidationError } from '../lib/errors';
import {
  DEFAULT_CAPTURE_POLICY,
  capturePolicyRawContent,
  formatRedactionDiagnostics,
  loadContextCaptureIgnoreFile,
  normalizeCapturePolicyMode,
  safeNormalizeWorkspaceRelativePath,
  sanitizeCapturePayload,
  sanitizeCliCommandEvent,
  shouldCapturePath,
  type CapturePolicyMode,
} from '../lib/context-safety';
import {
  CONTEXT_EVENT_PAYLOAD_SCHEMA_VERSION,
  ContextCaptureEventJobPayload,
  ContextEventTypeEnum,
  SourceSystemEnum,
  deriveContextEventIdempotencyKey,
  type CaptureSourceType,
  type UnifiedContextEventPayloadType,
} from '../lib/context-capture-contracts';
import {
  appendContextCaptureAudit,
  getContextCaptureControlState,
  getContextCaptureMonitoring,
  getContextCaptureQueueDepth,
  listContextCaptureAudit,
  recordContextCaptureSubmission,
  upsertContextCaptureControlState,
} from '../lib/context-capture-controls';
import {
  getMemoryCandidateCounts,
  getMemoryDistillationSettings,
  upsertMemoryDistillationSettings,
  type MemoryDistillationMode,
} from '../lib/context-distillation';
import {
  importExternalMemoryCandidates,
  stageExternalMemoryImportCandidates,
  type ExternalMemoryImportFormat,
  type ExternalMemoryImportVendor,
} from '../lib/external-memory-import-adapters';
import { getBoss } from '../lib/pg-boss';
import { attachTopicSSE, broadcastTopic } from '../lib/sse-hub';

const router = Router();

type WorkspaceRow = { id: string; label: string; path: string };

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${name} is required`);
  return value.trim();
}

async function loadWorkspace(workspaceId: string): Promise<WorkspaceRow> {
  const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) throw new NotFoundError('Workspace', workspaceId);
  return workspace;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parsePositiveInt(value: unknown, name: string, fallback: number, max: number): number {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new ValidationError(`${name} must be an integer between 1 and ${max}`);
  return parsed;
}

function sourceSystemFor(source: CaptureSourceType): string {
  return {
    repoDaemon: 'repo_daemon',
    gitHook: 'git_hook',
    shellIntegration: 'shell',
    vscodeExtension: 'vscode',
    agentAdapter: 'agent_adapter',
    mcpSlashCommand: 'mcp',
    ciPrIngestion: 'ci',
    externalImport: 'external_import',
  }[source];
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function normalizeRelatedFiles(value: unknown, workspacePath: string): Array<{ path: string; role: 'opened' | 'saved' | 'changed' | 'mentioned' | 'diagnostic' | 'reviewed' | null; hash: string | null }> {
  if (!Array.isArray(value)) return [];
  const ignore = loadContextCaptureIgnoreFile(workspacePath);
  return value.flatMap((item) => {
    const rawPath = typeof item === 'string' ? item : stringValue((item as Record<string, unknown> | null)?.path);
    if (!rawPath) return [];
    let normalized: string;
    try {
      normalized = safeNormalizeWorkspaceRelativePath(workspacePath, rawPath);
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : `Invalid related path: ${rawPath}`);
    }
    if (!shouldCapturePath(normalized, { paths: ignore?.patterns ?? [] })) return [];
    const record = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
    const role = typeof record.role === 'string' && ['opened', 'saved', 'changed', 'mentioned', 'diagnostic', 'reviewed'].includes(record.role)
      ? record.role as 'opened' | 'saved' | 'changed' | 'mentioned' | 'diagnostic' | 'reviewed'
      : 'mentioned';
    return [{ path: normalized, role, hash: stringValue(record.hash) }];
  });
}

function assertAgentMetadata(raw: Record<string, unknown>, source: CaptureSourceType): void {
  const eventType = stringValue(raw.eventType);
  if (source !== 'agentAdapter' && source !== 'mcpSlashCommand' && eventType !== 'agent_memory' && eventType !== 'adapter_context') return;
  const identity = raw.source_identity && typeof raw.source_identity === 'object' ? raw.source_identity as Record<string, unknown> : {};
  for (const key of ['source_system', 'tool_name', 'session_id']) {
    if (!stringValue(raw[key] ?? identity[key])) throw new ValidationError(`Adapter payload requires ${key} metadata`);
  }
}

export function normalizeContextEventPayload(input: {
  payload: unknown;
  workspaceId: string;
  workspacePath: string;
  source: CaptureSourceType;
  occurredAt: string;
  policyMode: CapturePolicyMode;
  policyVersion: string;
}): UnifiedContextEventPayloadType {
  if (!input.payload || typeof input.payload !== 'object') throw new ValidationError('Context capture payload must be an object');
  const raw = input.payload as Record<string, unknown>;
  assertAgentMetadata(raw, input.source);
  const identity = raw.source_identity && typeof raw.source_identity === 'object' ? raw.source_identity as Record<string, unknown> : {};
  const legacyType = stringValue(raw.eventType);
  const eventType = legacyType === 'cli_command' ? 'shell_command'
    : legacyType === 'agent_memory' || legacyType === 'adapter_context' ? 'explicit_memory'
      : legacyType ?? (stringValue(raw.commit ?? raw.git_sha ?? raw.gitSha) ? 'git_commit' : 'explicit_memory');
  if (!ContextEventTypeEnum.safeParse(eventType).success) throw new ValidationError('Unsupported context capture event type', { eventType });

  const sourceSystemCandidate = stringValue(raw.source_system ?? identity.source_system) ?? sourceSystemFor(input.source);
  const sourceSystem = SourceSystemEnum.safeParse(sourceSystemCandidate).success ? sourceSystemCandidate : sourceSystemFor(input.source);
  const toolName = stringValue(raw.tool_name ?? identity.tool_name) ?? sourceSystem;
  const hostApplication = stringValue(raw.host_application ?? identity.host_application) ?? (input.source === 'vscodeExtension' ? 'vscode' : null);
  const sessionId = stringValue(raw.session_id ?? identity.session_id);
  const gitSha = stringValue(raw.git_sha ?? raw.gitSha ?? raw.commit);
  const gitBranch = stringValue(raw.git_branch ?? raw.gitBranch);
  const relatedFiles = normalizeRelatedFiles(raw.related_files ?? raw.relatedFiles ?? raw.changed_files ?? raw.changedFiles, input.workspacePath);
  const policyMode = normalizeCapturePolicyMode(raw.policyMode ?? raw.policy_mode ?? input.policyMode);
  const repoPathHash = stringValue(raw.repo_path_hash ?? identity.repo_path_hash) ?? sha256(path.resolve(input.workspacePath));
  const sourceIdentity = { source_system: sourceSystem, tool_name: toolName, host_application: hostApplication, session_id: sessionId, workspace_id: input.workspaceId, repo_path_hash: repoPathHash };
  const base = {
    payload_schema_version: CONTEXT_EVENT_PAYLOAD_SCHEMA_VERSION,
    source_identity: sourceIdentity,
    source_system: sourceSystem,
    tool_name: toolName,
    host_application: hostApplication,
    session_id: sessionId,
    workspace_id: input.workspaceId,
    repo_path_hash: repoPathHash,
    git_branch: gitBranch,
    git_sha: gitSha,
    related_files: relatedFiles,
    capture_policy: {
      policy_version: stringValue((raw.capture_policy as Record<string, unknown> | undefined)?.policy_version) ?? input.policyVersion,
      mode: policyMode,
      raw_content: capturePolicyRawContent(policyMode),
    },
    trust_tier: raw.trust_tier === 'untrusted' || raw.trust_tier === 'verified' || raw.trust_tier === 'privileged' ? raw.trust_tier : 'local' as const,
    provenance: {
      capture_source: input.source,
      source_event_id: stringValue(raw.source_event_id ?? raw.id),
      adapter_version: stringValue(raw.adapter_version),
      emitted_at: stringValue(raw.emitted_at) ?? input.occurredAt,
      received_at: new Date().toISOString(),
      local_only: raw.local_only !== false,
    },
  };

  const commandSummary = stringValue(raw.command_summary ?? raw.commandSummary);
  const commandHash = stringValue(raw.command_hash ?? raw.commandHash) ?? sha256(String(raw.command ?? commandSummary ?? ''));
  const memorySummary = stringValue(raw.memory_summary ?? raw.memory ?? raw.summary ?? raw.rule ?? raw.context ?? raw.title) ?? 'Explicit memory';
  const memoryHash = stringValue(raw.memory_hash) ?? sha256(memorySummary);
  const idempotencyKey = stringValue(raw.idempotency_key) ?? deriveContextEventIdempotencyKey({
    eventType: eventType as never,
    source_system: sourceSystem,
    tool_name: toolName,
    host_application: hostApplication,
    session_id: sessionId,
    workspace_id: input.workspaceId,
    occurred_at: input.occurredAt,
    command_hash: commandHash,
    phase: stringValue(raw.phase),
    exit_code: numberValue(raw.exit_code ?? raw.exitCode),
    git_sha: gitSha,
    memory_hash: memoryHash,
    activity_type: stringValue(raw.activity_type),
    related_files: relatedFiles,
    provider: stringValue(raw.provider),
    repository: stringValue(raw.repository),
    pr_number: raw.pr_number as string | number | null | undefined,
    head_sha: stringValue(raw.head_sha ?? raw.headSha),
    run_id: stringValue(raw.run_id ?? raw.runId),
  });

  let normalized: Record<string, unknown>;
  if (eventType === 'agent_cli_session' || eventType === 'shell_command') {
    const agentRaw = raw.agent && typeof raw.agent === 'object' ? raw.agent as Record<string, unknown> : {};
    const binaryCandidate = stringValue(agentRaw.binary) ?? (eventType === 'agent_cli_session' ? toolName : 'unknown');
    const binary = ['claude', 'codex', 'opencode', 'pi', 'aider', 'cursor', 'custom'].includes(binaryCandidate) ? binaryCandidate : eventType === 'agent_cli_session' ? 'custom' : 'unknown';
    normalized = {
      ...base, eventType, idempotency_key: idempotencyKey,
      phase: raw.phase === 'start' ? 'start' : 'end', policyMode,
      command_summary: commandSummary, command_hash: commandHash,
      cwd: stringValue(raw.cwd), exit_code: numberValue(raw.exit_code ?? raw.exitCode),
      duration_ms: numberValue(raw.duration_ms ?? raw.durationMs),
      agent: { recognized: eventType === 'agent_cli_session' || agentRaw.recognized === true, binary, matchedPattern: stringValue(agentRaw.matchedPattern) },
      regulated_signals: Array.isArray(raw.regulated_signals) ? raw.regulated_signals.filter((item): item is string => typeof item === 'string') : [],
    };
  } else if (eventType === 'git_commit') {
    normalized = { ...base, eventType, idempotency_key: idempotencyKey, git_sha: gitSha, commit_subject: stringValue(raw.commit_subject ?? raw.subject), committed_at: stringValue(raw.committed_at ?? raw.committedAt), author_hash: stringValue(raw.author_hash), changed_files: relatedFiles };
  } else if (eventType === 'ci_pr') {
    normalized = { ...base, eventType, idempotency_key: idempotencyKey, provider: ['github', 'gitlab', 'circleci', 'buildkite', 'jenkins'].includes(String(raw.provider)) ? raw.provider : 'other', repository: stringValue(raw.repository) ?? 'unknown', pr_number: raw.pr_number ?? raw.prNumber ?? 'unknown', head_sha: stringValue(raw.head_sha ?? raw.headSha) ?? gitSha ?? 'unknown000', base_branch: stringValue(raw.base_branch ?? raw.baseBranch), status: ['queued', 'running', 'success', 'failure', 'cancelled'].includes(String(raw.status)) ? raw.status : 'unknown', run_id: stringValue(raw.run_id ?? raw.runId) };
  } else if (eventType === 'ide_session') {
    normalized = { ...base, eventType, idempotency_key: idempotencyKey, ide_session_state: ['started', 'active', 'ended'].includes(String(raw.ide_session_state)) ? raw.ide_session_state : 'active', workspace_folders: Array.isArray(raw.workspace_folders) ? raw.workspace_folders.filter((item): item is string => typeof item === 'string') : [], extension_version: stringValue(raw.extension_version) };
  } else if (eventType === 'editor_activity') {
    normalized = { ...base, eventType, idempotency_key: idempotencyKey, activity_type: ['open', 'save', 'close', 'diagnostic', 'selection', 'command'].includes(String(raw.activity_type)) ? raw.activity_type : 'command', document_uri_hash: stringValue(raw.document_uri_hash), language_id: stringValue(raw.language_id), summary: stringValue(raw.summary) };
  } else {
    normalized = { ...base, eventType: 'explicit_memory', idempotency_key: idempotencyKey, memory_hash: memoryHash, memory_summary: memorySummary, category: stringValue(raw.category), requested_by: raw.requested_by === 'agent' || raw.requested_by === 'system' || legacyType === 'agent_memory' || legacyType === 'adapter_context' ? 'agent' : 'human' };
  }

  const parsed = ContextCaptureEventJobPayload.shape.payload.safeParse(normalized);
  if (!parsed.success) throw new ValidationError('Invalid context capture event payload', { issues: parsed.error.issues });
  return parsed.data;
}

function captureCapability() {
  return {
    overall: 'active',
    sources: {
      repoDaemon: { status: 'active' },
      gitHook: { status: 'active' },
      shellIntegration: { status: 'active' },
      vscodeExtension: { status: 'degraded', reason: 'extension_host_optional', fallbackSources: ['repoDaemon', 'gitHook', 'shellIntegration', 'mcpSlashCommand'] },
      mcpSlashCommand: { status: 'active' },
      agentAdapters: { status: 'active', tools: ['pi', 'claude-code', 'codex', 'opencode'], requiredMetadata: ['source_system', 'tool_name', 'session_id'] },
    },
    policy: { version: DEFAULT_CAPTURE_POLICY.version, availableModes: ['off', 'metadata-only', 'repo-and-command', 'ide-assisted', 'full'], rawContentDefault: DEFAULT_CAPTURE_POLICY.rawContentDefault },
    distillation: { queueName: 'context:distill', defaultMode: 'conservative-auto-candidates', modes: ['off', 'explicit-only', 'conservative-auto-candidates', 'trusted-auto-approve'] },
  };
}

function topic(workspaceId: string): string { return `context-capture:${workspaceId}`; }
function publish(workspaceId: string, event: Record<string, unknown>): void { broadcastTopic(topic(workspaceId), { workspaceId, occurredAt: new Date().toISOString(), ...event }); }

/**
 * @swagger
 * /api/context-capture/bootstrap/verify:
 *   post:
 *     tags: [Context Capture]
 *     summary: Verify always-on capture bootstrap inputs
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Verifies operator-managed workspace paths before reversible setup mutates local integration files."
 *     responses:
 *       200: { description: Bootstrap inputs verified }
 */
router.post('/bootstrap/verify', async (req, res) => {
  const workspaceId = requiredString(req.body.workspaceId, 'workspaceId');
  const workspace = await loadWorkspace(workspaceId);
  const workspacePath = path.resolve(requiredString(req.body.workspacePath, 'workspacePath'));
  if (workspacePath !== path.resolve(workspace.path)) throw new ValidationError('workspacePath does not match registered workspace path');
  if (!fs.existsSync(workspacePath)) throw new ValidationError('Registered workspace path does not exist');
  const expected = {
    queuePath: path.join(workspacePath, '.rorca-capture-queue.jsonl'),
    redactionConfigPath: path.join(workspacePath, '.rorca', 'capture', 'redaction.json'),
    captureIgnorePath: path.join(workspacePath, '.rorca-captureignore'),
  };
  for (const [name, value] of Object.entries(expected)) {
    if (path.resolve(requiredString(req.body[name], name)) !== path.resolve(value)) throw new ValidationError(`${name} must be ${path.relative(workspacePath, value)}`);
  }
  res.json({ ok: true, workspace, checks: Object.entries(expected).map(([id, value]) => ({ id, ok: true, path: value })) });
});

/**
 * @swagger
 * /api/context-capture/events:
 *   post:
 *     tags: [Context Capture]
 *     summary: Submit a policy-gated context event
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Always-on telemetry submission is an operator-controlled write gated by explicit local policy and pause state."
 *     responses:
 *       200: { description: Event accepted or safely suppressed }
 *       503: { description: Queue unavailable; caller retains its redacted local copy }
 */
router.post('/events', async (req, res) => {
  const workspaceId = requiredString(req.body.workspaceId, 'workspaceId');
  const sourceResult = ContextCaptureEventJobPayload.shape.source.safeParse(req.body.source);
  if (!sourceResult.success) throw new ValidationError('Invalid context capture source', { issues: sourceResult.error.issues });
  const occurredAt = requiredString(req.body.occurredAt, 'occurredAt');
  if (Number.isNaN(Date.parse(occurredAt))) throw new ValidationError('occurredAt must be an ISO timestamp');
  const workspace = await loadWorkspace(workspaceId);
  const control = await getContextCaptureControlState(workspaceId);
  const requestedMode = normalizeCapturePolicyMode(req.body.policyMode ?? req.body.payload?.policyMode);
  const policyMode = control.policyMode === 'off' ? requestedMode : control.policyMode;
  const raw = req.body.payload ?? {};
  const integrationId = `${sourceResult.data}:${stringValue(raw.tool_name) ?? 'unknown'}`;

  if (control.paused || control.policyMode === 'off' || policyMode === 'off') {
    const safety = sanitizeCapturePayload({ suppressed: control.paused ? 'paused' : 'policy_off', source: sourceResult.data }).safety;
    await recordContextCaptureSubmission({ workspaceId, eventType: 'capture_suppressed', integrationId, payloadEventType: stringValue(raw.eventType), safety });
    publish(workspaceId, { type: 'capture_suppressed', reason: control.paused ? 'paused' : 'policy_off' });
    res.json({ ok: true, accepted: false, reason: control.paused ? 'paused' : 'policy_off', safety, redactionDiagnostics: formatRedactionDiagnostics(safety), capability: captureCapability() });
    return;
  }

  const isCommand = ['cli_command', 'shell_command', 'agent_cli_session'].includes(String(raw.eventType)) || typeof raw.command === 'string';
  const sanitized = isCommand
    ? sanitizeCliCommandEvent({ ...raw, policyMode, workspacePath: workspace.path, captureIgnorePatterns: loadContextCaptureIgnoreFile(workspace.path)?.patterns ?? [] })
    : sanitizeCapturePayload(raw, { ...DEFAULT_CAPTURE_POLICY, rawContentDefault: policyMode === 'full' ? 'explicit' : DEFAULT_CAPTURE_POLICY.rawContentDefault });
  if (sanitized.payload === null) {
    await recordContextCaptureSubmission({ workspaceId, eventType: 'capture_suppressed', integrationId, payloadEventType: stringValue(raw.eventType), safety: sanitized.safety });
    res.json({ ok: true, accepted: false, reason: 'capture_ignore', safety: sanitized.safety, redactionDiagnostics: formatRedactionDiagnostics(sanitized.safety) });
    return;
  }
  const payload = normalizeContextEventPayload({ payload: sanitized.payload, workspaceId, workspacePath: workspace.path, source: sourceResult.data, occurredAt: new Date(occurredAt).toISOString(), policyMode, policyVersion: sanitized.safety.policyVersion });
  const event = ContextCaptureEventJobPayload.parse({ workspaceId, source: sourceResult.data, occurredAt: new Date(occurredAt).toISOString(), payload, safety: sanitized.safety });

  let jobId: string | null;
  try {
    const boss = getBoss();
    await boss.createQueue('context:capture');
    jobId = await boss.send('context:capture', event, { retryLimit: 3 });
  } catch (error) {
    throw new ServiceUnavailableError(`Context capture queue unavailable; retain local queued copy: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!jobId) throw new ServiceUnavailableError('Context capture queue rejected the event; retain local queued copy.');
  await recordContextCaptureSubmission({ workspaceId, eventType: 'capture_submitted', integrationId, payloadEventType: payload.eventType, safety: sanitized.safety });
  publish(workspaceId, { type: 'capture_submitted', integrationId, payloadEventType: payload.eventType });
  res.json({ ok: true, accepted: true, queued: true, queueName: 'context:capture', queueJobId: jobId, workspaceId, payload, safety: sanitized.safety, redactionDiagnostics: formatRedactionDiagnostics(sanitized.safety), capability: captureCapability() });
});

/**
 * @swagger
 * /api/context-capture/capability:
 *   get:
 *     tags: [Context Capture]
 *     summary: Report local context capture capability
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Read-only user-owned capability and policy metadata has no write side effects."
 *     responses:
 *       200: { description: Capture capability }
 */
router.get('/capability', (_req, res) => res.json({ captureCapability: captureCapability() }));

/**
 * @swagger
 * /api/context-capture/{workspaceId}/status:
 *   get:
 *     tags: [Context Capture]
 *     summary: Get always-on capture control status
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Includes operator-only queue, audit, ignore, and redaction policy state."
 *     responses:
 *       200: { description: Capture status }
 */
router.get('/:workspaceId/status', async (req, res) => {
  const workspace = await loadWorkspace(requiredString(req.params.workspaceId, 'workspaceId'));
  const control = await getContextCaptureControlState(workspace.id);
  res.json({ ok: true, workspace, status: { ...control, ignoredPaths: loadContextCaptureIgnoreFile(workspace.path)?.patterns ?? [], queueDepth: await getContextCaptureQueueDepth(workspace.id), auditLog: await listContextCaptureAudit(workspace.id, 20), redactionPolicy: { version: DEFAULT_CAPTURE_POLICY.version, mode: control.policyMode, availableModes: ['off', 'metadata-only', 'repo-and-command', 'ide-assisted', 'full'] } }, capability: captureCapability() });
});

function readDaemonStatus(workspacePath: string): Record<string, unknown> {
  const statusPath = path.join(workspacePath, '.rorca', 'capture', 'status.json');
  if (!fs.existsSync(statusPath)) return { status: 'missing', queueDepth: 0, lastSeen: null, lastFlush: null };
  try { return { status: 'available', ...JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown> }; }
  catch { return { status: 'invalid', queueDepth: 0, lastSeen: null, lastFlush: null }; }
}

/**
 * @swagger
 * /api/context-capture/{workspaceId}/monitoring:
 *   get:
 *     tags: [Context Capture]
 *     summary: Get aggregate always-on capture monitoring
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Aggregated queue, distillation, audit, daemon, and worker health is operator-only diagnostics."
 *     responses:
 *       200: { description: Monitoring signals }
 */
router.get('/:workspaceId/monitoring', async (req, res) => {
  const workspace = await loadWorkspace(requiredString(req.params.workspaceId, 'workspaceId'));
  const monitoring = await getContextCaptureMonitoring(workspace.id, parsePositiveInt(req.query.windowHours, 'windowHours', 24, 720));
  const daemon = readDaemonStatus(workspace.path);
  const reasons: string[] = [];
  const advisories: string[] = [];
  if (daemon.status !== 'available') reasons.push(`capture_daemon_${daemon.status}`);
  if (!monitoring.queues.capture.available || !monitoring.queues.distillation.available) reasons.push('queue_metrics_unavailable');
  if (!monitoring.distillation.available) reasons.push('distillation_metrics_unavailable');
  if (!monitoring.audit.available) reasons.push('audit_metrics_unavailable');
  if (monitoring.queues.capture.failed > 0) reasons.push('capture_jobs_failed');
  if (monitoring.queues.distillation.failed > 0) reasons.push('distillation_jobs_failed');
  if (monitoring.distillation.activeErrors > 0) reasons.push('distillation_events_error');
  if (monitoring.distillation.acceptedHistoricalErrors > 0) advisories.push('distillation_historical_errors_accepted');
  if (monitoring.worker.status !== 'ok') reasons.push(`worker_${monitoring.worker.status}`);
  res.json({ ok: true, status: reasons.length === 0 ? 'healthy' : 'degraded', reasons, advisories, workspace: { id: workspace.id, label: workspace.label }, daemon, backend: { status: 'ok', pid: process.pid, uptimeSeconds: Math.round(process.uptime()) }, ...monitoring });
});

/**
 * @swagger
 * /api/context-capture/{workspaceId}/stream:
 *   get:
 *     tags: [Context Capture]
 *     summary: Stream capture status updates
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Streams operator-only local capture state through the shared SSE hub."
 *     responses:
 *       200: { description: Capture SSE stream }
 */
router.get('/:workspaceId/stream', async (req, res) => {
  const workspace = await loadWorkspace(requiredString(req.params.workspaceId, 'workspaceId'));
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  const unsubscribe = attachTopicSSE(topic(workspace.id), res, 'capture_event');
  req.on('close', unsubscribe);
});

/**
 * @swagger
 * /api/context-capture/{workspaceId}/policy:
 *   patch:
 *     tags: [Context Capture]
 *     summary: Update explicit capture policy
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Changing telemetry policy or integrations is operator-only configuration."
 *     responses:
 *       200: { description: Policy updated }
 */
router.patch('/:workspaceId/policy', async (req, res) => {
  const workspace = await loadWorkspace(requiredString(req.params.workspaceId, 'workspaceId'));
  const mode = normalizeCapturePolicyMode(req.body.policyMode ?? req.body.mode, 'off');
  const activeIntegrations = req.body.activeIntegrations && typeof req.body.activeIntegrations === 'object' ? req.body.activeIntegrations as Record<string, unknown> : undefined;
  const ignoredPaths = Array.isArray(req.body.ignoredPaths) ? req.body.ignoredPaths.filter((item: unknown): item is string => typeof item === 'string') : undefined;
  const status = await upsertContextCaptureControlState({ workspaceId: workspace.id, policyMode: mode, activeIntegrations, ignoredPaths });
  await appendContextCaptureAudit({ workspaceId: workspace.id, eventType: 'policy_update', integrationId: 'operator' });
  publish(workspace.id, { type: 'policy_update', policyMode: mode });
  res.json({ ok: true, status });
});

for (const action of ['pause', 'resume'] as const) {
  /**
   * @swagger
   * /api/context-capture/{workspaceId}/pause:
   *   post:
   *     tags: [Context Capture]
   *     summary: Pause always-on capture
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Pause is an operator-only privacy control."
   *     responses:
   *       200: { description: Capture paused }
   */
  /**
   * @swagger
   * /api/context-capture/{workspaceId}/resume:
   *   post:
   *     tags: [Context Capture]
   *     summary: Resume always-on capture
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Resume re-enables operator-configured telemetry under explicit policy."
   *     responses:
   *       200: { description: Capture resumed }
   */
  router.post(`/:workspaceId/${action}`, async (req, res) => {
    const workspace = await loadWorkspace(requiredString(req.params.workspaceId, 'workspaceId'));
    const status = await upsertContextCaptureControlState({ workspaceId: workspace.id, paused: action === 'pause' });
    await appendContextCaptureAudit({ workspaceId: workspace.id, eventType: action, integrationId: 'operator' });
    publish(workspace.id, { type: action, paused: action === 'pause' });
    res.json({ ok: true, status });
  });
}

/**
 * @swagger
 * /api/context-capture/{workspaceId}/uninstall:
 *   post:
 *     tags: [Context Capture]
 *     summary: Disable capture and cancel pending capture jobs
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Uninstall is an operator-only privacy action that disables integrations and cancels queued telemetry through pg-boss APIs."
 *     responses:
 *       200: { description: Capture disabled }
 */
router.post('/:workspaceId/uninstall', async (req, res) => {
  const workspace = await loadWorkspace(requiredString(req.params.workspaceId, 'workspaceId'));
  const jobs = await query<{ id: string }>("SELECT id::text FROM pgboss.job WHERE name = 'context:capture' AND COALESCE(data->>'workspaceId', data->'data'->>'workspaceId') = $1 AND state IN ('created', 'retry')", [workspace.id]).catch(() => []);
  let cancelled = 0;
  const boss = getBoss();
  for (const job of jobs) {
    await boss.cancel('context:capture', job.id);
    cancelled += 1;
  }
  const status = await upsertContextCaptureControlState({ workspaceId: workspace.id, policyMode: 'off', paused: true, activeIntegrations: {}, ignoredPaths: [] });
  await appendContextCaptureAudit({ workspaceId: workspace.id, eventType: 'uninstall', integrationId: 'operator' });
  publish(workspace.id, { type: 'uninstall', cancelledQueueEntries: cancelled });
  res.json({ ok: true, status, cancelledQueueEntries: cancelled });
});

/**
 * @swagger
 * /api/context-capture/imports/{workspaceId}:
 *   post:
 *     tags: [Context Capture]
 *     summary: Import external memory exports as pending candidates
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Bulk local imports create review candidates and can expose code context, so they are operator-only."
 *     responses:
 *       200: { description: Import preview or staged candidates }
 */
router.post('/imports/:workspaceId', async (req, res) => {
  const workspace = await loadWorkspace(requiredString(req.params.workspaceId, 'workspaceId'));
  const vendor = requiredString(req.body.vendor, 'vendor') as ExternalMemoryImportVendor;
  const adapter = req.body.adapter === 'memory-bank-file' || req.body.adapter === 'trace-memory-api' ? req.body.adapter : undefined;
  const dryRun = req.body.dryRun !== false;
  let sourceFile: string | undefined;
  if (typeof req.body.sourceFile === 'string' && req.body.sourceFile.trim()) {
    sourceFile = path.resolve(workspace.path, req.body.sourceFile);
    const relative = path.relative(workspace.path, sourceFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ValidationError('sourceFile must be inside the workspace');
  }
  const format = req.body.format === 'json' || req.body.format === 'jsonl' || req.body.format === 'markdown' ? req.body.format as ExternalMemoryImportFormat : undefined;
  const apiItems = Array.isArray(req.body.apiItems) ? req.body.apiItems : undefined;
  const result = await importExternalMemoryCandidates({ workspaceId: workspace.id, workspacePath: workspace.path, vendor, adapter, dryRun, limit: parsePositiveInt(req.body.limit, 'limit', 100, 500), source: { filePath: sourceFile, rawText: typeof req.body.rawText === 'string' ? req.body.rawText : undefined, format, apiEndpoint: stringValue(req.body.apiEndpoint) ?? undefined, apiProvider: apiItems ? async () => apiItems : undefined } });
  const staged = dryRun ? undefined : await stageExternalMemoryImportCandidates(result.candidates);
  res.json({ ok: true, workspaceId: workspace.id, result: { ...result, diagnostics: { ...result.diagnostics, stagedCandidates: staged?.inserted ?? 0 } }, staged });
});

/**
 * @swagger
 * /api/context-capture/distillation/{workspaceId}/config:
 *   get:
 *     tags: [Context Capture]
 *     summary: Get distillation settings
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Distillation and auto-approval settings are operator-only automation controls."
 *     responses:
 *       200: { description: Distillation settings }
 */
router.get('/distillation/:workspaceId/config', async (req, res) => {
  const workspace = await loadWorkspace(requiredString(req.params.workspaceId, 'workspaceId'));
  res.json({ ok: true, workspaceId: workspace.id, settings: await getMemoryDistillationSettings(workspace.id), candidateCounts: await getMemoryCandidateCounts(workspace.id) });
});
/**
 * @swagger
 * /api/context-capture/distillation/{workspaceId}/config:
 *   patch:
 *     tags: [Context Capture]
 *     summary: Update distillation settings
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Changing candidate automation or auto-approval is operator-only configuration."
 *     responses:
 *       200: { description: Updated distillation settings }
 */
router.patch('/distillation/:workspaceId/config', async (req, res) => {
  const workspace = await loadWorkspace(requiredString(req.params.workspaceId, 'workspaceId'));
  const mode = req.body.mode as MemoryDistillationMode | undefined;
  if (mode && !['off', 'explicit-only', 'conservative-auto-candidates', 'trusted-auto-approve'].includes(mode)) throw new ValidationError('Invalid distillation mode');
  if (req.body.operatorAutoApprove === true && mode !== 'trusted-auto-approve' && (await getMemoryDistillationSettings(workspace.id)).mode !== 'trusted-auto-approve') throw new ValidationError('operatorAutoApprove requires trusted-auto-approve mode');
  const settings = await upsertMemoryDistillationSettings(workspace.id, {
    ...(mode ? { mode } : {}),
    ...(typeof req.body.operatorAutoApprove === 'boolean' ? { operatorAutoApprove: req.body.operatorAutoApprove } : {}),
    ...(typeof req.body.llmSummarization === 'boolean' ? { llmSummarization: req.body.llmSummarization } : {}),
    ...(req.body.maxEventsPerJob != null ? { maxEventsPerJob: parsePositiveInt(req.body.maxEventsPerJob, 'maxEventsPerJob', 25, 100) } : {}),
  });
  res.json({ ok: true, workspaceId: workspace.id, settings });
});

export default router;
