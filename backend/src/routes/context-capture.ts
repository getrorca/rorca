/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { queryOne } from '../db/index';
import { NotFoundError, ServiceUnavailableError, ValidationError } from '../lib/errors';
import { DEFAULT_CAPTURE_POLICY, capturePolicyRawContent, formatRedactionDiagnostics, normalizeCapturePolicyMode, sanitizeCapturePayload, sanitizeCliCommandEvent, type CapturePolicyMode } from '../lib/context-safety';
import { getBoss } from '../lib/pg-boss';
import {
  applyMemoryCandidateReviewAction,
  approveMemoryCandidate,
  getMemoryCandidateCounts,
  getMemoryDistillationSettings,
  listMemoryCandidates,
  rejectMemoryCandidate,
  upsertMemoryDistillationSettings,
  type MemoryCandidateReviewAction,
  type MemoryCandidateStatus,
  type MemoryDistillationMode,
} from '../lib/context-distillation';
import {
  CONTEXT_EVENT_PAYLOAD_SCHEMA_VERSION,
  ContextCaptureEventJobPayload,
  ContextEventTypeEnum,
  SourceSystemEnum,
  deriveContextEventIdempotencyKey,
  type CaptureSourceType,
  type UnifiedContextEventPayloadType,
} from '../lib/pg-boss-schemas';
import {
  appendContextCaptureAudit,
  drainContextCaptureQueue,
  getContextCaptureControlState,
  getContextCaptureQueueDepth,
  listContextCaptureAudit,
  recordContextCaptureSubmission,
  upsertContextCaptureControlState,
} from '../lib/context-capture-controls';
import { attachTopicSSE, broadcastTopic } from '../lib/sse-hub';
import { importExternalMemoryCandidates, stageExternalMemoryImportCandidates, type ExternalMemoryImportFormat, type ExternalMemoryImportVendor } from '../lib/external-memory-import-adapters';

const router = Router();

type WorkspaceRow = {
  id: string;
  label: string;
  path: string;
};

function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${name} is required`);
  }
  return value;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInsideWorkspace(workspacePath: string, candidatePath: string, name: string): void {
  if (!isInside(workspacePath, candidatePath)) {
    throw new ValidationError(`${name} must be inside the workspace path`, { workspacePath, candidatePath });
  }
}

function assertExpectedBootstrapPath(workspacePath: string, candidatePath: string, name: string, expectedRelativePath: string): void {
  assertInsideWorkspace(workspacePath, candidatePath, name);
  const expectedPath = path.resolve(workspacePath, expectedRelativePath);
  if (path.resolve(candidatePath) !== expectedPath) {
    throw new ValidationError(`${name} must be ${expectedRelativePath} for always-on capture setup`, {
      workspacePath,
      candidatePath,
      expectedPath,
    });
  }
}

function parseDistillationMode(value: unknown): MemoryDistillationMode {
  if (value === 'off' || value === 'explicit-only' || value === 'conservative-auto-candidates' || value === 'trusted-auto-approve') return value;
  throw new ValidationError('Invalid distillation mode', { mode: value });
}

function parseCandidateStatus(value: unknown): MemoryCandidateStatus | 'all' {
  if (value === undefined || value === null || value === 'all') return 'all';
  if (value === 'pending' || value === 'review_required' || value === 'approved' || value === 'rejected' || value === 'auto_approved') return value;
  throw new ValidationError('Invalid candidate status', { status: value });
}

function parseOptionalString(value: unknown, fieldName: string, allowed?: readonly string[]): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${fieldName} must be a string`);
  if (allowed && !allowed.includes(value)) throw new ValidationError(`Invalid ${fieldName}`, { [fieldName]: value, allowed });
  return value;
}

function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  throw new ValidationError(`${fieldName} must be true or false`);
}

function parseCandidateReviewAction(value: unknown): MemoryCandidateReviewAction {
  if (value === 'edit' || value === 'duplicate' || value === 'supersede' || value === 'conflict' || value === 'defer') return value;
  throw new ValidationError('Invalid candidate review action', { action: value });
}

function contextCaptureTopic(workspaceId: string): string {
  return `context-capture:${workspaceId}`;
}

function publishCaptureEvent(workspaceId: string, event: Record<string, unknown>): void {
  broadcastTopic(contextCaptureTopic(workspaceId), { workspaceId, occurredAt: new Date().toISOString(), ...event });
}

function parsePositiveInt(value: unknown, fieldName: string, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new ValidationError(`${fieldName} must be an integer between 1 and ${max}`);
  return parsed;
}

function parseCandidateId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ValidationError('candidateId must be a positive integer');
  return parsed;
}

function parsePolicyMode(value: unknown): CapturePolicyMode {
  return normalizeCapturePolicyMode(value, 'metadata-only');
}

function parseImportVendor(value: unknown): ExternalMemoryImportVendor {
  const vendor = assertString(value, 'vendor') as ExternalMemoryImportVendor;
  return vendor;
}

function parseImportFormat(value: unknown): ExternalMemoryImportFormat | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'json' || value === 'jsonl' || value === 'markdown') return value;
  throw new ValidationError('Invalid import format', { format: value });
}

function resolveWorkspaceSourceFile(workspacePath: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = assertString(value, 'sourceFile');
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(workspacePath, raw);
  assertInsideWorkspace(workspacePath, resolved, 'sourceFile');
  return resolved;
}

function isCliCapturePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const eventType = (payload as Record<string, unknown>).eventType;
  return eventType === 'cli_command' || eventType === 'shell_command' || eventType === 'agent_cli_session' || typeof (payload as Record<string, unknown>).command === 'string';
}

function assertAgentMetadata(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const obj = payload as Record<string, unknown>;
  if (obj.eventType !== 'agent_memory' && obj.eventType !== 'adapter_context' && obj.eventType !== 'explicit_memory') return;
  for (const key of ['source_system', 'tool_name', 'session_id']) {
    const sourceIdentity = obj.source_identity && typeof obj.source_identity === 'object' ? obj.source_identity as Record<string, unknown> : undefined;
    const value = obj[key] ?? sourceIdentity?.[key];
    if (typeof value !== 'string' || !String(value).trim()) {
      throw new ValidationError(`Adapter payload requires ${key} metadata`);
    }
  }
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sourceSystemFor(source: CaptureSourceType): string {
  const mapping: Record<CaptureSourceType, string> = {
    repoDaemon: 'repo_daemon',
    gitHook: 'git_hook',
    shellIntegration: 'shell',
    vscodeExtension: 'vscode',
    agentAdapter: 'agent_adapter',
    mcpSlashCommand: 'mcp',
    ciPrIngestion: 'ci',
    externalImport: 'external_import',
  };
  return mapping[source];
}

function normalizeRelatedFiles(value: unknown): Array<{ path: string; role: 'opened' | 'saved' | 'changed' | 'mentioned' | 'diagnostic' | 'reviewed' | null; hash: string | null }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [{ path: item, role: 'mentioned' as const, hash: null }];
    if (!item || typeof item !== 'object') return [];
    const obj = item as Record<string, unknown>;
    const filePath = stringValue(obj.path);
    if (!filePath) return [];
    const role = typeof obj.role === 'string' && ['opened', 'saved', 'changed', 'mentioned', 'diagnostic', 'reviewed'].includes(obj.role) ? obj.role as 'opened' | 'saved' | 'changed' | 'mentioned' | 'diagnostic' | 'reviewed' : null;
    return [{ path: filePath, role, hash: stringValue(obj.hash) }];
  });
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
  if (!input.payload || typeof input.payload !== 'object') {
    throw new ValidationError('Context capture payload must be an object');
  }

  const raw = input.payload as Record<string, unknown>;
  const rawIdentity = raw.source_identity && typeof raw.source_identity === 'object' ? raw.source_identity as Record<string, unknown> : {};
  const legacyEventType = stringValue(raw.eventType);
  const adapterMemoryAliases = new Set(['agent_memory', 'adapter_context']);
  const normalizedEventType = legacyEventType && adapterMemoryAliases.has(legacyEventType)
    ? 'explicit_memory'
    : legacyEventType === 'cli_command'
      ? 'shell_command'
      : legacyEventType;
  const inferredEventType = normalizedEventType ?? (stringValue(raw.commit) || stringValue(raw.git_sha) || stringValue(raw.gitSha) ? 'git_commit' : null);
  if (!inferredEventType || !ContextEventTypeEnum.safeParse(inferredEventType).success) {
    throw new ValidationError('Unsupported context capture event type', { eventType: raw.eventType });
  }

  const sourceSystemCandidate = stringValue(raw.source_system) ?? stringValue(rawIdentity.source_system) ?? sourceSystemFor(input.source);
  const sourceSystem = SourceSystemEnum.safeParse(sourceSystemCandidate).success ? sourceSystemCandidate : sourceSystemFor(input.source);
  const toolName = stringValue(raw.tool_name) ?? stringValue(rawIdentity.tool_name) ?? stringValue((raw.agent as Record<string, unknown> | undefined)?.binary) ?? sourceSystem;
  const hostApplication = stringValue(raw.host_application) ?? stringValue(rawIdentity.host_application) ?? (input.source === 'vscodeExtension' ? 'vscode' : null);
  const sessionId = stringValue(raw.session_id) ?? stringValue(rawIdentity.session_id);
  const repoPathHash = stringValue(raw.repo_path_hash) ?? stringValue(rawIdentity.repo_path_hash) ?? sha256(path.resolve(input.workspacePath));
  const gitBranch = stringValue(raw.git_branch) ?? stringValue(raw.gitBranch);
  const gitSha = stringValue(raw.git_sha) ?? stringValue(raw.gitSha) ?? stringValue(raw.commit);
  const relatedFiles = normalizeRelatedFiles(raw.related_files ?? raw.relatedFiles ?? raw.changed_files ?? raw.changedFiles);
  const policyMode = parsePolicyMode(raw.policyMode ?? raw.policy_mode ?? input.policyMode);
  const sourceIdentity = {
    source_system: sourceSystem,
    tool_name: toolName,
    host_application: hostApplication,
    session_id: sessionId,
    workspace_id: input.workspaceId,
    repo_path_hash: repoPathHash,
  };
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
      source_event_id: stringValue(raw.source_event_id) ?? stringValue(raw.id),
      adapter_version: stringValue(raw.adapter_version),
      emitted_at: stringValue(raw.emitted_at) ?? input.occurredAt,
      received_at: new Date().toISOString(),
      local_only: raw.local_only !== false,
    },
  };

  const commandHash = stringValue(raw.command_hash) ?? stringValue(raw.commandHash);
  const commandSummary = stringValue(raw.command_summary) ?? stringValue(raw.commandSummary);
  const exitCode = numberValue(raw.exit_code) ?? numberValue(raw.exitCode);
  const durationMs = numberValue(raw.duration_ms) ?? numberValue(raw.durationMs);
  const agent = raw.agent && typeof raw.agent === 'object' ? raw.agent as Record<string, unknown> : {};
  const normalizedAgent = {
    recognized: Boolean(agent.recognized),
    binary: stringValue(agent.binary) ?? 'unknown',
    matchedPattern: stringValue(agent.matchedPattern),
  };
  const memorySummary = stringValue(raw.memory_summary) ?? stringValue(raw.memory) ?? stringValue(raw.summary) ?? stringValue(raw.rule) ?? stringValue(raw.context) ?? stringValue(raw.title) ?? 'Explicit memory';
  const memoryHash = stringValue(raw.memory_hash) ?? sha256(memorySummary);

  const idempotencyKey = stringValue(raw.idempotency_key) ?? deriveContextEventIdempotencyKey({
    eventType: inferredEventType as never,
    source_system: sourceSystem,
    tool_name: toolName,
    host_application: hostApplication,
    session_id: sessionId,
    workspace_id: input.workspaceId,
    occurred_at: input.occurredAt,
    command_hash: commandHash,
    phase: stringValue(raw.phase),
    exit_code: exitCode,
    git_sha: gitSha,
    memory_hash: memoryHash,
    activity_type: stringValue(raw.activity_type),
    related_files: relatedFiles,
    provider: stringValue(raw.provider),
    repository: stringValue(raw.repository),
    pr_number: raw.pr_number as string | number | null | undefined,
    head_sha: stringValue(raw.head_sha) ?? stringValue(raw.headSha),
    run_id: stringValue(raw.run_id),
  });

  const normalized = (() => {
    if (inferredEventType === 'agent_cli_session' || inferredEventType === 'shell_command') {
      return {
        ...base,
        eventType: inferredEventType,
        idempotency_key: idempotencyKey,
        phase: raw.phase === 'start' ? 'start' : 'end',
        policyMode,
        command_summary: commandSummary,
        command_hash: commandHash ?? sha256(String(raw.command ?? commandSummary ?? '')),
        cwd: stringValue(raw.cwd),
        exit_code: exitCode,
        duration_ms: durationMs,
        agent: inferredEventType === 'agent_cli_session' ? { ...normalizedAgent, recognized: true, binary: normalizedAgent.binary === 'unknown' ? 'custom' : normalizedAgent.binary } : normalizedAgent,
        regulated_signals: Array.isArray(raw.regulated_signals) ? raw.regulated_signals : Array.isArray(raw.regulatedSignals) ? raw.regulatedSignals : [],
      };
    }
    if (inferredEventType === 'git_commit') {
      return {
        ...base,
        eventType: inferredEventType,
        idempotency_key: idempotencyKey,
        git_sha: gitSha,
        commit_subject: stringValue(raw.commit_subject) ?? stringValue(raw.subject),
        committed_at: stringValue(raw.committed_at) ?? stringValue(raw.committedAt),
        author_hash: stringValue(raw.author_hash),
        changed_files: relatedFiles,
      };
    }
    if (inferredEventType === 'ci_pr') {
      return {
        ...base,
        eventType: inferredEventType,
        idempotency_key: idempotencyKey,
        provider: stringValue(raw.provider) ?? 'other',
        repository: stringValue(raw.repository) ?? 'unknown',
        pr_number: raw.pr_number ?? raw.prNumber ?? 'unknown',
        head_sha: stringValue(raw.head_sha) ?? stringValue(raw.headSha) ?? gitSha ?? 'unknown',
        base_branch: stringValue(raw.base_branch) ?? stringValue(raw.baseBranch),
        status: ['queued', 'running', 'success', 'failure', 'cancelled', 'unknown'].includes(String(raw.status)) ? raw.status : 'unknown',
        run_id: stringValue(raw.run_id) ?? stringValue(raw.runId),
      };
    }
    if (inferredEventType === 'ide_session') {
      return {
        ...base,
        eventType: inferredEventType,
        idempotency_key: idempotencyKey,
        ide_session_state: ['started', 'active', 'ended'].includes(String(raw.ide_session_state)) ? raw.ide_session_state : 'active',
        workspace_folders: Array.isArray(raw.workspace_folders) ? raw.workspace_folders : [],
        extension_version: stringValue(raw.extension_version),
      };
    }
    if (inferredEventType === 'editor_activity') {
      return {
        ...base,
        eventType: inferredEventType,
        idempotency_key: idempotencyKey,
        activity_type: ['open', 'save', 'close', 'diagnostic', 'selection', 'command'].includes(String(raw.activity_type)) ? raw.activity_type : 'command',
        document_uri_hash: stringValue(raw.document_uri_hash),
        language_id: stringValue(raw.language_id),
        summary: stringValue(raw.summary),
      };
    }
    return {
      ...base,
      eventType: 'explicit_memory',
      idempotency_key: idempotencyKey,
      memory_hash: memoryHash,
      memory_summary: memorySummary,
      category: stringValue(raw.category),
      requested_by: raw.requested_by === 'agent' || raw.requested_by === 'system' ? raw.requested_by : legacyEventType && adapterMemoryAliases.has(legacyEventType) ? 'agent' : 'human',
    };
  })();

  const parsed = ContextCaptureEventJobPayload.shape.payload.safeParse(normalized);
  if (!parsed.success) {
    throw new ValidationError('Invalid context capture event payload', { issues: parsed.error.issues });
  }
  return parsed.data;
}

function readCaptureIgnorePatterns(workspacePath: string): string[] {
  const ignorePath = path.join(workspacePath, '.rorca-captureignore');
  if (!fs.existsSync(ignorePath)) return [];
  return fs.readFileSync(ignorePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function captureCapability() {
  return {
    overall: 'active',
    sources: {
      repoDaemon: { status: 'active' },
      gitHook: { status: 'active' },
      shellIntegration: { status: 'active' },
      vscodeExtension: {
        status: 'degraded',
        reason: 'extension_host_optional',
        fallbackSources: ['repoDaemon', 'gitHook', 'shellIntegration', 'mcpSlashCommand'],
      },
      mcpSlashCommand: { status: 'active' },
      agentAdapters: {
        status: 'active',
        tools: ['pi', 'claude-code', 'codex', 'opencode'],
        requiredMetadata: ['source_system', 'tool_name', 'session_id'],
        fallbackSources: ['shellIntegration', 'gitHook', 'repoDaemon'],
      },
    },
    policy: {
      version: DEFAULT_CAPTURE_POLICY.version,
      availableModes: ['off', 'metadata-only', 'repo-and-command', 'ide-assisted', 'full'],
      rawContentDefault: DEFAULT_CAPTURE_POLICY.rawContentDefault,
      maxStringBytes: DEFAULT_CAPTURE_POLICY.maxStringBytes,
      maxPayloadBytes: DEFAULT_CAPTURE_POLICY.maxPayloadBytes,
      hashAlgorithm: DEFAULT_CAPTURE_POLICY.hashAlgorithm,
    },
    distillation: {
      queueName: 'context:distill',
      defaultMode: 'conservative-auto-candidates',
      modes: ['off', 'explicit-only', 'conservative-auto-candidates', 'trusted-auto-approve'],
      defaultCandidateStatus: 'pending',
      securitySensitiveStatus: 'review_required',
    },
  };
}

/**
 * @swagger
 * /api/context-capture/bootstrap/verify:
 *   post:
 *     tags: [Context Capture]
 *     summary: Verify always-on capture bootstrap inputs
 *     operationId: verifyContextCaptureBootstrap
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Capture bootstrap verification prepares operator-level always-on integrations and local filesystem paths before an explicit setup action mutates reversible workspace files."
 *     description: Validates workspace registration, repository path, and planned capture queue/redaction/ignore paths for the explicit always-on capture setup command. This endpoint performs verification only; it does not install hooks or modify shell/editor configuration.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, workspacePath, queuePath, redactionConfigPath, captureIgnorePath]
 *             properties:
 *               workspaceId: { type: string }
 *               workspacePath: { type: string }
 *               queuePath: { type: string }
 *               redactionConfigPath: { type: string }
 *               captureIgnorePath: { type: string }
 *     responses:
 *       200:
 *         description: Bootstrap inputs verified
 *       400: { description: Invalid bootstrap input }
 *       404: { description: Workspace not found }
 */
router.post('/bootstrap/verify', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.body.workspaceId, 'workspaceId');
    const workspacePath = path.resolve(assertString(req.body.workspacePath, 'workspacePath'));
    const queuePath = path.resolve(assertString(req.body.queuePath, 'queuePath'));
    const redactionConfigPath = path.resolve(assertString(req.body.redactionConfigPath, 'redactionConfigPath'));
    const captureIgnorePath = path.resolve(assertString(req.body.captureIgnorePath, 'captureIgnorePath'));

    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }

    const registeredPath = path.resolve(workspace.path);
    if (registeredPath !== workspacePath) {
      throw new ValidationError('workspacePath does not match registered workspace path', {
        registeredPath,
        workspacePath,
      });
    }

    if (!fs.existsSync(registeredPath)) {
      throw new ValidationError('Registered workspace path does not exist', { registeredPath });
    }

    assertExpectedBootstrapPath(registeredPath, queuePath, 'queuePath', path.join('.rorca', 'capture', 'queue'));
    assertExpectedBootstrapPath(registeredPath, redactionConfigPath, 'redactionConfigPath', path.join('.rorca', 'capture', 'redaction.json'));
    assertExpectedBootstrapPath(registeredPath, captureIgnorePath, 'captureIgnorePath', '.rorca-captureignore');

    res.json({
      ok: true,
      workspace,
      checks: [
        { id: 'workspace-registration', ok: true, message: 'Workspace is registered', path: registeredPath },
        { id: 'repo-path', ok: true, message: 'Workspace path exists', path: registeredPath },
        { id: 'queue-path', ok: true, message: 'Capture queue path is workspace-scoped', path: queuePath },
        { id: 'redaction-config', ok: true, message: 'Redaction config path is workspace-scoped', path: redactionConfigPath },
        { id: 'capture-ignore', ok: true, message: '.rorca-captureignore path is workspace-scoped', path: captureIgnorePath },
      ],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/events:
 *   post:
 *     tags: [Context Capture]
 *     summary: Submit a redacted context capture event
 *     operationId: submitContextCaptureEvent
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local shell, daemon, IDE, and agent capture submissions are operator-controlled telemetry writes gated by explicit local policy and pause state."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, source, occurredAt, payload]
 *             properties:
 *               workspaceId: { type: string }
 *               source: { type: string }
 *               occurredAt: { type: string }
 *               payload: { type: object }
 *     responses:
 *       200: { description: Event accepted }
 *       400: { description: Invalid event }
 *       404: { description: Workspace not found }
 *       503: { description: Capture queue unavailable; client should keep local queued copy }
 */
router.post('/events', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.body.workspaceId, 'workspaceId');
    const source = assertString(req.body.source, 'source');
    const parsedSource = ContextCaptureEventJobPayload.shape.source.safeParse(source);
    if (!parsedSource.success) {
      throw new ValidationError('Invalid context capture source', { issues: parsedSource.error.issues });
    }
    const occurredAt = assertString(req.body.occurredAt, 'occurredAt');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);

    const payload = req.body.payload ?? {};
    assertAgentMetadata(payload);
    const control = await getContextCaptureControlState(workspaceId);
    const requestedPolicyMode = parsePolicyMode(req.body.policyMode ?? (payload as Record<string, unknown>).policyMode);
    const policyMode = control.policyMode === 'off' ? requestedPolicyMode : control.policyMode;
    const ignorePatterns = readCaptureIgnorePatterns(workspace.path);
    const integrationId = `${source}:${typeof (payload as Record<string, unknown>).tool_name === 'string' ? (payload as Record<string, unknown>).tool_name : 'unknown'}`;
    if (control.paused || control.policyMode === 'off' || policyMode === 'off') {
      const safety = sanitizeCapturePayload({ skipped: control.paused ? 'paused' : 'policy_off', source, eventType: (payload as Record<string, unknown>).eventType }).safety;
      await recordContextCaptureSubmission({ workspaceId, eventType: 'capture_suppressed', integrationId, payloadEventType: String((payload as Record<string, unknown>).eventType ?? 'unknown'), safety });
      publishCaptureEvent(workspaceId, { type: 'capture_suppressed', source, integrationId, reason: control.paused ? 'paused' : 'policy_off' });
      res.json({
        ok: true,
        accepted: false,
        workspaceId,
        source,
        occurredAt,
        reason: control.paused ? 'paused' : 'policy_off',
        safety,
        redactionDiagnostics: formatRedactionDiagnostics(safety),
        capability: captureCapability(),
      });
      return;
    }
    if (isCliCapturePayload(payload) && (payload as Record<string, unknown>).transcript !== undefined && policyMode !== 'full') {
      throw new ValidationError('Transcript capture requires full explicit-session summary policy');
    }

    const sanitized = isCliCapturePayload(payload)
      ? sanitizeCliCommandEvent({
        ...(payload as Record<string, unknown>),
        policyMode,
        workspacePath: workspace.path,
        captureIgnorePatterns: ignorePatterns,
      })
      : sanitizeCapturePayload(payload, {
        ...DEFAULT_CAPTURE_POLICY,
        rawContentDefault: policyMode === 'full' ? 'explicit' : DEFAULT_CAPTURE_POLICY.rawContentDefault,
      });

    if (sanitized.payload === null) {
      await recordContextCaptureSubmission({ workspaceId, eventType: 'capture_suppressed', integrationId, payloadEventType: 'capture_ignore', safety: sanitized.safety });
      publishCaptureEvent(workspaceId, { type: 'capture_suppressed', source, integrationId, reason: 'capture_ignore' });
      res.json({
        ok: true,
        accepted: false,
        workspaceId,
        source,
        occurredAt,
        reason: 'capture_ignore',
        safety: sanitized.safety,
        redactionDiagnostics: formatRedactionDiagnostics(sanitized.safety),
        capability: captureCapability(),
      });
      return;
    }

    const normalizedPayload = normalizeContextEventPayload({
      payload: sanitized.payload,
      workspaceId,
      workspacePath: workspace.path,
      source: parsedSource.data,
      occurredAt,
      policyMode,
      policyVersion: sanitized.safety.policyVersion,
    });
    const event = ContextCaptureEventJobPayload.safeParse({ workspaceId, source: parsedSource.data, occurredAt, payload: normalizedPayload, safety: sanitized.safety });
    if (!event.success) {
      throw new ValidationError('Invalid context capture event payload', { issues: event.error.issues });
    }

    let queuedJobId: string | null = null;
    try {
      const boss = getBoss();
      await boss.createQueue('context:capture');
      queuedJobId = await boss.send('context:capture', event.data, { retryLimit: 3 });
    } catch (error) {
      throw new ServiceUnavailableError(`Context capture queue unavailable; local capture client should keep the event queued for retry: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!queuedJobId) {
      throw new ServiceUnavailableError('Context capture queue rejected the event; local capture client should keep the event queued for retry.');
    }

    await recordContextCaptureSubmission({ workspaceId, eventType: 'capture_submitted', integrationId, payloadEventType: event.data.payload.eventType, safety: sanitized.safety });
    publishCaptureEvent(workspaceId, { type: 'capture_submitted', source, integrationId, payloadEventType: event.data.payload.eventType });

    res.json({
      ok: true,
      accepted: true,
      queued: true,
      queueName: 'context:capture',
      queueJobId: queuedJobId,
      workspaceId,
      source,
      occurredAt,
      payload: event.data.payload,
      safety: sanitized.safety,
      redactionDiagnostics: formatRedactionDiagnostics(sanitized.safety),
      capability: captureCapability(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/capability:
 *   get:
 *     tags: [Context Capture]
 *     summary: Report local context capture capability and policy
 *     operationId: getContextCaptureCapability
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Capability reporting exposes user-owned local capture health and policy with no write side effects."
 *     responses:
 *       200: { description: Capture capability }
 */
router.get('/capability', (_req, res) => {
  res.json({ captureCapability: captureCapability() });
});

/**
 * @swagger
 * /api/context-capture/{workspaceId}/status:
 *   get:
 *     tags: [Context Capture]
 *     summary: Get always-on capture privacy/control status
 *     operationId: getContextCaptureStatus
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Capture status exposes operator-only local integration, pause, queue, audit, ignore, and redaction policy state."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Capture control status }
 *       404: { description: Workspace not found }
 */
router.get('/:workspaceId/status', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    const control = await getContextCaptureControlState(workspaceId);
    const ignoredPaths = readCaptureIgnorePatterns(workspace.path);
    const queueDepth = await getContextCaptureQueueDepth(workspaceId);
    const auditLog = await listContextCaptureAudit(workspaceId, 20);
    res.json({
      ok: true,
      workspace,
      status: {
        ...control,
        ignoredPaths,
        queueDepth,
        redactionPolicy: {
          version: DEFAULT_CAPTURE_POLICY.version,
          mode: control.policyMode,
          rawContentDefault: DEFAULT_CAPTURE_POLICY.rawContentDefault,
          availableModes: ['off', 'metadata-only', 'repo-and-command', 'ide-assisted', 'full'],
        },
        auditLog,
      },
      capability: captureCapability(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/{workspaceId}/stream:
 *   get:
 *     tags: [Context Capture]
 *     summary: Stream always-on capture status updates
 *     operationId: streamContextCaptureStatus
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Streams operator-only local capture queue/action changes through the SSE hub for live status dashboards."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: text/event-stream with capture_event messages }
 */
router.get('/:workspaceId/stream', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    const unsubscribe = attachTopicSSE(contextCaptureTopic(workspaceId), res, 'capture_event');
    req.on('close', unsubscribe);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/{workspaceId}/policy:
 *   patch:
 *     tags: [Context Capture]
 *     summary: Update always-on capture policy and active integrations
 *     operationId: updateContextCapturePolicy
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Changing capture policy enables/disables local telemetry integrations and is operator-only configuration."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Capture policy updated }
 *       400: { description: Invalid policy }
 *       404: { description: Workspace not found }
 */
router.patch('/:workspaceId/policy', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    const mode = normalizeCapturePolicyMode(req.body.policyMode ?? req.body.mode, 'off');
    const activeIntegrations = req.body.activeIntegrations && typeof req.body.activeIntegrations === 'object' ? req.body.activeIntegrations as Record<string, unknown> : undefined;
    const ignoredPaths = Array.isArray(req.body.ignoredPaths) ? req.body.ignoredPaths.filter((item: unknown): item is string => typeof item === 'string') : undefined;
    const state = await upsertContextCaptureControlState({ workspaceId, policyMode: mode, activeIntegrations, ignoredPaths });
    await appendContextCaptureAudit({ workspaceId, eventType: 'policy_update', integrationId: 'operator' });
    publishCaptureEvent(workspaceId, { type: 'policy_update', policyMode: state.policyMode, paused: state.paused });
    res.json({ ok: true, workspaceId, status: state });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/{workspaceId}/pause:
 *   post:
 *     tags: [Context Capture]
 *     summary: Pause always-on capture submissions
 *     operationId: pauseContextCapture
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Pausing capture is an operator-only privacy control that suppresses queue submissions across integrations."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Capture paused }
 */
router.post('/:workspaceId/pause', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    const status = await upsertContextCaptureControlState({ workspaceId, paused: true });
    await appendContextCaptureAudit({ workspaceId, eventType: 'pause', integrationId: 'operator' });
    publishCaptureEvent(workspaceId, { type: 'pause', paused: true });
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/{workspaceId}/resume:
 *   post:
 *     tags: [Context Capture]
 *     summary: Resume always-on capture submissions
 *     operationId: resumeContextCapture
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Resuming capture is an operator-only privacy control that re-enables queue submissions under the explicit policy."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Capture resumed }
 */
router.post('/:workspaceId/resume', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    const status = await upsertContextCaptureControlState({ workspaceId, paused: false });
    await appendContextCaptureAudit({ workspaceId, eventType: 'resume', integrationId: 'operator' });
    publishCaptureEvent(workspaceId, { type: 'resume', paused: false });
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/{workspaceId}/uninstall:
 *   post:
 *     tags: [Context Capture]
 *     summary: Mark capture integrations uninstalled and drain pending capture queue
 *     operationId: uninstallContextCapture
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Uninstalling capture removes operator integrations and drains local telemetry queues, so it is operator-only maintenance."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Capture uninstalled }
 */
router.post('/:workspaceId/uninstall', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    const drainedQueueEntries = await drainContextCaptureQueue(workspaceId);
    const status = await upsertContextCaptureControlState({ workspaceId, policyMode: 'off', paused: true, activeIntegrations: {}, ignoredPaths: [] });
    await appendContextCaptureAudit({ workspaceId, eventType: 'uninstall', integrationId: 'operator' });
    publishCaptureEvent(workspaceId, { type: 'uninstall', drainedQueueEntries });
    res.json({ ok: true, status, drainedQueueEntries });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/imports/{workspaceId}:
 *   post:
 *     tags: [Context Capture]
 *     summary: Import external memory or trace exports as pending review candidates
 *     operationId: importExternalContextMemory
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Bulk-importing third-party memory/traces can expose local code context and creates review candidates, so it is operator-only maintenance surface."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vendor]
 *             properties:
 *               vendor: { type: string }
 *               adapter: { type: string, enum: [memory-bank-file, trace-memory-api] }
 *               dryRun: { type: boolean, default: true }
 *               sourceFile: { type: string, description: Workspace-relative JSON, JSONL, or Markdown export path }
 *               rawText: { type: string, description: Inline JSON/JSONL/Markdown export content }
 *               format: { type: string, enum: [json, jsonl, markdown] }
 *               apiEndpoint: { type: string }
 *               apiItems: { type: array, items: { type: object }, description: Operator-supplied API export rows; used instead of vendor SDK dependencies }
 *               limit: { type: integer, minimum: 1, maximum: 500 }
 *     responses:
 *       200: { description: Import candidates produced or staged }
 *       400: { description: Malformed export or invalid request }
 *       404: { description: Workspace not found }
 *       422: { description: Unknown or unsupported vendor }
 */
router.post('/imports/:workspaceId', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);

    const vendor = parseImportVendor(req.body.vendor);
    const adapter = req.body.adapter === 'memory-bank-file' || req.body.adapter === 'trace-memory-api' ? req.body.adapter : undefined;
    const dryRun = req.body.dryRun !== false;
    const sourceFile = resolveWorkspaceSourceFile(workspace.path, req.body.sourceFile);
    const rawText = typeof req.body.rawText === 'string' ? req.body.rawText : undefined;
    const format = parseImportFormat(req.body.format);
    const apiEndpoint = typeof req.body.apiEndpoint === 'string' && req.body.apiEndpoint.trim() ? req.body.apiEndpoint.trim() : undefined;
    const apiItems = Array.isArray(req.body.apiItems) ? req.body.apiItems : undefined;
    const limit = parsePositiveInt(req.body.limit, 'limit', 100, 500);

    const result = await importExternalMemoryCandidates({
      workspaceId,
      workspacePath: workspace.path,
      vendor,
      adapter,
      dryRun,
      limit,
      source: {
        filePath: sourceFile,
        rawText,
        format,
        apiEndpoint,
        apiProvider: apiItems ? async () => apiItems : undefined,
      },
    });
    const staged = dryRun ? undefined : await stageExternalMemoryImportCandidates(result.candidates);
    res.json({ ok: true, workspaceId, result: { ...result, diagnostics: { ...result.diagnostics, stagedCandidates: staged?.inserted ?? 0 } }, staged });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/distillation/{workspaceId}/config:
 *   get:
 *     tags: [Context Capture]
 *     summary: Get context-event memory distillation settings
 *     operationId: getContextDistillationConfig
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Distillation mode controls local operator automation and potential auto-approval of memory candidates, so it is operator-only maintenance surface."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Distillation configuration and candidate counts }
 *       404: { description: Workspace not found }
 */
router.get('/distillation/:workspaceId/config', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    const settings = await getMemoryDistillationSettings(workspaceId);
    const candidateCounts = await getMemoryCandidateCounts(workspaceId);
    res.json({ ok: true, workspaceId, settings, candidateCounts });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/distillation/{workspaceId}/config:
 *   patch:
 *     tags: [Context Capture]
 *     summary: Update context-event memory distillation settings
 *     operationId: updateContextDistillationConfig
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Changing distillation and trusted auto-approve policy is an operator-only side effect that can alter how local context becomes reviewable memory."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode: { type: string, enum: [off, explicit-only, conservative-auto-candidates, trusted-auto-approve] }
 *               operatorAutoApprove: { type: boolean }
 *               llmSummarization: { type: boolean }
 *               maxEventsPerJob: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200: { description: Distillation configuration updated }
 *       400: { description: Invalid configuration }
 *       404: { description: Workspace not found }
 */
router.patch('/distillation/:workspaceId/config', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);

    const patch: Parameters<typeof upsertMemoryDistillationSettings>[1] = {};
    if (req.body.mode !== undefined) patch.mode = parseDistillationMode(req.body.mode);
    if (req.body.operatorAutoApprove !== undefined) {
      if (typeof req.body.operatorAutoApprove !== 'boolean') throw new ValidationError('operatorAutoApprove must be a boolean');
      patch.operatorAutoApprove = req.body.operatorAutoApprove;
    }
    if (req.body.llmSummarization !== undefined) {
      if (typeof req.body.llmSummarization !== 'boolean') throw new ValidationError('llmSummarization must be a boolean');
      patch.llmSummarization = req.body.llmSummarization;
    }
    if (req.body.maxEventsPerJob !== undefined) {
      if (!Number.isInteger(req.body.maxEventsPerJob) || req.body.maxEventsPerJob < 1 || req.body.maxEventsPerJob > 100) {
        throw new ValidationError('maxEventsPerJob must be an integer between 1 and 100');
      }
      patch.maxEventsPerJob = req.body.maxEventsPerJob;
    }

    const settings = await upsertMemoryDistillationSettings(workspaceId, patch);
    const candidateCounts = await getMemoryCandidateCounts(workspaceId);
    res.json({ ok: true, workspaceId, settings, candidateCounts });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/distillation/{workspaceId}/candidates:
 *   get:
 *     tags: [Context Capture]
 *     summary: List reviewable memory candidates from context distillation
 *     operationId: listContextDistillationCandidates
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Candidate review exposes local captured context snippets and approval state, so it is operator-only maintenance surface."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [all, pending, review_required, approved, rejected, auto_approved] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200: { description: Candidate list }
 *       404: { description: Workspace not found }
 */
router.get('/distillation/:workspaceId/candidates', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    const status = parseCandidateStatus(req.query.status);
    const limit = parsePositiveInt(req.query.limit, 'limit', 50, 100);
    const sourceSystem = parseOptionalString(req.query.sourceSystem, 'sourceSystem');
    const toolName = parseOptionalString(req.query.toolName, 'toolName');
    const hostApp = parseOptionalString(req.query.hostApp, 'hostApp');
    const eventType = parseOptionalString(req.query.eventType, 'eventType');
    const trustTier = parseOptionalString(req.query.trustTier, 'trustTier', ['untrusted', 'local', 'verified', 'privileged']);
    const confidence = parseOptionalString(req.query.confidence, 'confidence', ['high', 'medium', 'low']);
    const regulatedFlag = parseOptionalBoolean(req.query.regulatedFlag, 'regulatedFlag');
    const candidates = await listMemoryCandidates({ workspaceId, status, limit, sourceSystem, toolName, hostApp, eventType, trustTier, confidence, regulatedFlag });
    res.json({ ok: true, workspaceId, candidates });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/distillation/{workspaceId}/candidates/{candidateId}/approve:
 *   post:
 *     tags: [Context Capture]
 *     summary: Approve a distilled memory candidate into default retrieval
 *     operationId: approveContextDistillationCandidate
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Approving a candidate promotes captured local context into retrieval memory, which is an operator-only side effect."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: candidateId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Candidate approved }
 *       404: { description: Workspace or candidate not found }
 */
router.post('/distillation/:workspaceId/candidates/:candidateId/approve', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    const candidateId = parseCandidateId(req.params.candidateId);
    const approved = await approveMemoryCandidate(workspaceId, candidateId);
    if (!approved) throw new NotFoundError('Memory candidate', String(candidateId));
    publishCaptureEvent(workspaceId, { type: 'candidate_approved', candidateId, memoryId: approved.memoryId });
    res.json({ ok: true, workspaceId, ...approved });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/distillation/{workspaceId}/candidates/{candidateId}/reject:
 *   post:
 *     tags: [Context Capture]
 *     summary: Reject a distilled memory candidate
 *     operationId: rejectContextDistillationCandidate
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Rejecting a candidate changes local memory review state and is operator-only maintenance surface."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: candidateId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Candidate rejected }
 *       404: { description: Workspace or candidate not found }
 */
router.post('/distillation/:workspaceId/candidates/:candidateId/reject', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    const candidateId = parseCandidateId(req.params.candidateId);
    const rejected = await rejectMemoryCandidate(workspaceId, candidateId);
    if (!rejected) throw new NotFoundError('Memory candidate', String(candidateId));
    publishCaptureEvent(workspaceId, { type: 'candidate_rejected', candidateId });
    res.json({ ok: true, workspaceId, candidateId, status: 'rejected' });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/distillation/{workspaceId}/candidates/{candidateId}/action:
 *   post:
 *     tags: [Context Capture]
 *     summary: Apply a review action to a context memory candidate
 *     operationId: actionContextDistillationCandidate
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Candidate review actions mutate local captured context review state and can alter later retrieval eligibility."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: candidateId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Candidate action applied }
 *       400: { description: Invalid action }
 *       404: { description: Workspace or candidate not found }
 */
router.post('/distillation/:workspaceId/candidates/:candidateId/action', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.params.workspaceId, 'workspaceId');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    const candidateId = parseCandidateId(req.params.candidateId);
    const action = parseCandidateReviewAction(req.body.action);
    const targetCandidateId = req.body.targetCandidateId === undefined || req.body.targetCandidateId === null || req.body.targetCandidateId === ''
      ? undefined
      : parseCandidateId(req.body.targetCandidateId);
    const result = await applyMemoryCandidateReviewAction({
      workspaceId,
      candidateId,
      action,
      content: typeof req.body.content === 'string' ? req.body.content : undefined,
      category: typeof req.body.category === 'string' ? req.body.category : undefined,
      confidence: req.body.confidence === 'high' || req.body.confidence === 'medium' || req.body.confidence === 'low' ? req.body.confidence : undefined,
      note: typeof req.body.note === 'string' ? req.body.note : undefined,
      targetCandidateId,
    });
    if (!result) throw new NotFoundError('Memory candidate', String(candidateId));
    publishCaptureEvent(workspaceId, { type: 'candidate_action', candidateId, action, targetCandidateId: targetCandidateId ?? null });
    res.json({ ok: true, workspaceId, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
