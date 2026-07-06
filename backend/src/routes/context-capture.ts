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
import { DEFAULT_CAPTURE_POLICY, sanitizeCapturePayload, sanitizeCliCommandEvent, type CapturePolicyMode } from '../lib/context-safety';
import { getBoss } from '../lib/pg-boss';
import {
  CONTEXT_EVENT_PAYLOAD_SCHEMA_VERSION,
  ContextCaptureEventJobPayload,
  ContextEventTypeEnum,
  SourceSystemEnum,
  deriveContextEventIdempotencyKey,
  type CaptureSourceType,
  type UnifiedContextEventPayloadType,
} from '../lib/pg-boss-schemas';

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

function parsePolicyMode(value: unknown): CapturePolicyMode {
  if (value === 'off' || value === 'metadata-only' || value === 'command-summary' || value === 'explicit-transcript-import') return value;
  return 'metadata-only';
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
  const inferredEventType = legacyEventType ?? (stringValue(raw.commit) || stringValue(raw.git_sha) || stringValue(raw.gitSha) ? 'git_commit' : null);
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
      raw_content: policyMode === 'explicit-transcript-import' ? 'explicit' as const : policyMode === 'command-summary' ? 'summary' as const : policyMode === 'off' ? 'off' as const : 'metadata' as const,
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
    memory_hash: stringValue(raw.memory_hash),
    activity_type: stringValue(raw.activity_type),
    related_files: relatedFiles,
    provider: stringValue(raw.provider),
    repository: stringValue(raw.repository),
    pr_number: raw.pr_number as string | number | null | undefined,
    head_sha: stringValue(raw.head_sha) ?? stringValue(raw.headSha),
    run_id: stringValue(raw.run_id),
  });

  const normalized = (() => {
    if (inferredEventType === 'agent_cli_session' || inferredEventType === 'cli_command' || inferredEventType === 'shell_command') {
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
      memory_hash: stringValue(raw.memory_hash) ?? sha256(String(raw.memory_summary ?? raw.memory ?? '')),
      memory_summary: stringValue(raw.memory_summary) ?? stringValue(raw.memory) ?? 'Explicit memory',
      category: stringValue(raw.category),
      requested_by: raw.requested_by === 'agent' || raw.requested_by === 'system' ? raw.requested_by : 'human',
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
      rawContentDefault: DEFAULT_CAPTURE_POLICY.rawContentDefault,
      maxStringBytes: DEFAULT_CAPTURE_POLICY.maxStringBytes,
      maxPayloadBytes: DEFAULT_CAPTURE_POLICY.maxPayloadBytes,
      hashAlgorithm: DEFAULT_CAPTURE_POLICY.hashAlgorithm,
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
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Capture bootstrap verification reads user-owned workspace registration and local filesystem paths before an explicit setup action mutates reversible workspace files."
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
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Local shell and daemon capture submit already-redacted command metadata through this stable public API; it has no operator side effects and never writes directly to context tables."
 *     x-rorca-public-api: true
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
    const policyMode = parsePolicyMode(req.body.policyMode ?? (payload as Record<string, unknown>).policyMode);
    const ignorePatterns = readCaptureIgnorePatterns(workspace.path);
    if (isCliCapturePayload(payload) && (payload as Record<string, unknown>).transcript !== undefined && policyMode !== 'explicit-transcript-import') {
      throw new ValidationError('Transcript capture requires explicit-transcript-import policy');
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
        rawContentDefault: policyMode === 'explicit-transcript-import' ? 'explicit' : DEFAULT_CAPTURE_POLICY.rawContentDefault,
      });

    if (sanitized.payload === null) {
      res.json({
        ok: true,
        accepted: false,
        workspaceId,
        source,
        occurredAt,
        reason: policyMode === 'off' ? 'policy_off' : 'capture_ignore',
        safety: sanitized.safety,
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

export default router;
