/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { BrowserProfileProviderBinding } from '../lib/authority-provider-adapter';
import {
  BrowserAuthenticationResolutionSchema,
  BrowserSessionReconciliationSchema,
  BrowserSessionRequestSchema,
  BrowserSessionRevocationSchema,
  BrowserSessionUseSchema,
  BrowserProfileEnrollmentMetadataSchema,
  CreateBrowserSessionGrantSchema,
  BrowserSessionBroker,
  browserSessionBroker,
  findBrowserProfileReceipts,
  type BrowserAuthenticationRequestRecord,
  type BrowserProfileBindingRecord,
  type BrowserSessionGrantRecord,
  type BrowserSessionLeaseRecord,
} from '../lib/browser-session-broker';
import { ValidationError } from '../lib/errors';
import {
  StartChatGptMcpConformanceJourneySchema,
  chatGptMcpConformanceJourneyController,
  type ChatGptMcpConformanceJourneyController,
} from '../lib/chatgpt-mcp-conformance-journey';
import {
  StartClaudeMcpConformanceJourneySchema,
  claudeMcpConformanceJourneyController,
  type ClaudeMcpConformanceJourneyController,
} from '../lib/claude-mcp-conformance-journey';
import { requireLocalOperatorBoundary } from '../lib/local-operator-boundary';


export const BrowserProfileLifecycleRequestSchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
  reason: z.enum([
    'operator_quarantine',
    'provider_unhealthy',
    'session_unhealthy',
    'operator_delete',
    'retention_expired',
  ]),
}).strict();

const BrowserProfileReceiptQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
}).strict();

const BrowserAuthenticationRunQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
}).strict();

const BrowserSessionUseBodySchema = BrowserSessionUseSchema.omit({ leaseId: true });
const BrowserSessionRevocationBodySchema = BrowserSessionRevocationSchema.omit({ leaseId: true });
const BrowserSessionReconciliationBodySchema = BrowserSessionReconciliationSchema.omit({ leaseId: true });
const ConformanceRunQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
}).strict();

function parseRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('Browser session broker request is invalid', {
      fields: parsed.error.issues.map((issue) => issue.path.join('.') || 'body'),
    });
  }
  return parsed.data;
}

export type ClaudeMcpConformanceRouteController = Pick<
  ClaudeMcpConformanceJourneyController,
  'start' | 'advance' | 'readByRun'
>;

export function dispatchClaudeMcpConformanceStart(
  input: unknown,
  conformance: ClaudeMcpConformanceRouteController,
) {
  return conformance.start(parseRequest(StartClaudeMcpConformanceJourneySchema, input));
}

export function dispatchClaudeMcpConformanceAdvance(
  journeyId: unknown,
  conformance: ClaudeMcpConformanceRouteController,
) {
  return conformance.advance(parseRequest(z.string().uuid(), journeyId));
}

export function dispatchClaudeMcpConformanceRead(
  queryInput: unknown,
  runIdInput: unknown,
  conformance: ClaudeMcpConformanceRouteController,
) {
  const query = parseRequest(ConformanceRunQuerySchema, queryInput);
  const runId = parseRequest(z.string().trim().min(1).max(255), runIdInput);
  return conformance.readByRun(query.workspaceId, runId);
}

export type ChatGptMcpConformanceRouteController = Pick<
  ChatGptMcpConformanceJourneyController,
  'start' | 'advance' | 'readByRun'
>;

export function dispatchChatGptMcpConformanceStart(
  input: unknown,
  conformance: ChatGptMcpConformanceRouteController,
) {
  return conformance.start(parseRequest(StartChatGptMcpConformanceJourneySchema, input));
}

export function dispatchChatGptMcpConformanceAdvance(
  journeyId: unknown,
  conformance: ChatGptMcpConformanceRouteController,
) {
  return conformance.advance(parseRequest(z.string().uuid(), journeyId));
}

export function dispatchChatGptMcpConformanceRead(
  queryInput: unknown,
  runIdInput: unknown,
  conformance: ChatGptMcpConformanceRouteController,
) {
  const query = parseRequest(ConformanceRunQuerySchema, queryInput);
  const runId = parseRequest(z.string().trim().min(1).max(255), runIdInput);
  return conformance.readByRun(query.workspaceId, runId);
}

export function projectBrowserProfileEnrollment(record: BrowserProfileBindingRecord): Record<string, unknown> {
  return {
    bindingId: record.id,
    workspaceId: record.workspaceId,
    externalProvider: record.externalProvider,
    accountAlias: record.accountAlias,
    allowedOrigins: record.allowedOrigins,
    profileGeneration: record.profileGeneration,
    profileStatus: record.lifecycleState,
    retentionPolicy: { mode: record.retentionMode, retainUntil: record.retainUntil },
    destructionPolicy: record.destructionPolicy,
    enrollmentProvenance: record.enrollmentProvenance,
    health: {
      provider: record.providerHealth,
      session: record.sessionHealth,
      observedAt: record.healthObservedAt,
    },
    operatorTakeover: {
      bindingId: record.id,
      modelControl: 'suspended',
      automationControl: 'suspended',
      profileCapture: 'isolated-enrollment-runner-only',
    },
  };
}
export function projectSettledBrowserProfile(binding: BrowserProfileProviderBinding): Record<string, unknown> {
  return {
    bindingId: binding.bindingId,
    workspaceId: binding.workspaceId,
    externalProvider: binding.externalProvider,
    accountAlias: binding.accountAlias,
    allowedOrigins: binding.allowedOrigins,
    profileGeneration: binding.profileGeneration,
    profileStatus: binding.profileStatus,
    retentionPolicy: binding.retentionPolicy,
    destructionPolicy: binding.destructionPolicy,
    enrollmentProvenance: binding.enrollmentProvenance,
    health: binding.health,
    providerProfileVerified: binding.providerProfileVerified,
  };
}

export function projectBrowserSessionGrant(grant: BrowserSessionGrantRecord): Record<string, unknown> {
  return {
    grantId: grant.id,
    bindingId: grant.bindingId,
    workspaceId: grant.workspaceId,
    externalProvider: grant.externalProvider,
    runId: grant.runId,
    storyId: grant.storyId,
    purpose: grant.purpose,
    profileGeneration: grant.profileGeneration,
    allowedOrigins: grant.allowedOrigins,
    allowedActions: grant.allowedActions,
    maximumConcurrentRunners: grant.maximumConcurrentRunners,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    evidenceContract: grant.evidenceContract,
    retentionPolicy: { mode: grant.retentionMode, retainUntil: grant.retainUntil },
    destructionPolicy: grant.destructionPolicy,
    state: grant.state,
  };
}

export function projectBrowserSessionLease(lease: BrowserSessionLeaseRecord): Record<string, unknown> {
  return {
    leaseId: lease.id,
    grantId: lease.grantId,
    bindingId: lease.bindingId,
    workspaceId: lease.workspaceId,
    externalProvider: lease.externalProvider,
    runId: lease.runId,
    storyId: lease.storyId,
    purpose: lease.purpose,
    profileGeneration: lease.profileGeneration,
    allowedOrigins: lease.allowedOrigins,
    allowedActions: lease.allowedActions,
    maximumConcurrentRunners: lease.maximumConcurrentRunners,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    lastHeartbeatAt: lease.lastHeartbeatAt,
    state: lease.state,
    evidenceContract: lease.evidenceContract,
    retentionPolicy: { mode: lease.retentionMode, retainUntil: lease.retainUntil },
    destructionPolicy: lease.destructionPolicy,
    runner: {
      runnerId: lease.runnerId,
      isolation: 'fresh-non-persistent-context',
      networkAccess: 'exact-origin-allowlist-only',
      modelContextAccess: 'none',
      filesystemAccess: 'ephemeral-profile-only',
      artifactAccess: 'redacted-only',
    },
  };
}

export function projectBrowserAuthenticationRequest(
  request: BrowserAuthenticationRequestRecord,
): Record<string, unknown> {
  const open = request.state === 'WAITING_FOR_AUTHENTICATION' || request.state === 'REVALIDATING';
  return {
    requestId: request.requestId,
    leaseId: request.leaseId,
    bindingId: request.bindingId,
    workspaceId: request.workspaceId,
    externalProvider: request.externalProvider,
    runId: request.runId,
    storyId: request.storyId,
    purpose: request.purpose,
    profileGeneration: request.profileGeneration,
    step: request.step,
    evidence: {
      schemaVersion: request.evidence.schemaVersion,
      observedAt: request.evidence.observedAt,
      currentOrigin: request.evidence.currentOrigin,
      signal: request.evidence.signal,
      providerStateDigest: request.evidence.providerStateDigest,
      accessibilityDigest: request.evidence.accessibilityDigest,
      screenshotDigest: request.evidence.screenshotDigest,
      automationPolicy: request.evidence.automationPolicy,
      redaction: request.evidence.redaction,
    },
    state: request.state,
    disposition: request.disposition,
    outcomeCode: request.outcomeCode,
    detectedAt: request.detectedAt,
    authenticationExpiresAt: request.authenticationExpiresAt,
    resolvedAt: request.resolvedAt,
    resumedAt: request.resumedAt,
    resumeCount: request.resumeCount,
    operatorTakeover: {
      surface: 'dedicated-browser-window',
      modelControl: open ? 'suspended' : 'unavailable',
      automationControl: open ? 'suspended' : request.state === 'RESUMED' ? 'resumed-once' : 'revoked',
      completionVerification: 'trusted-provider-state-required',
      allowedActions: open ? ['complete', 'cancel'] : [],
    },
  };
}

export function createBrowserSessionBrokerRouter(
  broker: BrowserSessionBroker = browserSessionBroker,
  claudeConformance: ClaudeMcpConformanceRouteController = claudeMcpConformanceJourneyController,
  chatGptConformance: ChatGptMcpConformanceRouteController = chatGptMcpConformanceJourneyController,
): Router {
  const router = Router({ strict: true, caseSensitive: true });
  router.use(requireLocalOperatorBoundary);

  /** @swagger
   * /api/browser-session-broker/grants:
   *   post:
   *     summary: Create a bounded browser-session authority grant
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local authority-only creation of an immutable run/story/purpose/profile scope; no profile or authentication material crosses HTTP."
   *     responses:
   *       201: { description: Metadata-only browser-session grant }
   *       403: { description: Scope broadens the profile or the broker is disabled }
   *       409: { description: Profile generation or health is stale }
   */
  router.post('/grants', async (req: Request, res: Response) => {
    const grant = await broker.createSessionGrant(parseRequest(CreateBrowserSessionGrantSchema, req.body));
    res.status(201).json(projectBrowserSessionGrant(grant));
  });

  /** @swagger
   * /api/browser-session-broker/sessions/request:
   *   post:
   *     summary: Request one fresh isolated runner lease under a browser-session grant
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local execution authority starts one exact-scope isolated runner; the response contains lease policy only and never a profile reference or path."
   *     responses:
   *       201: { description: Active isolated runner lease }
   *       403: { description: Scope or identity mismatch }
   *       409: { description: Expired grant, stale health, concurrency exhaustion, or reconciliation barrier }
   */
  router.post('/sessions/request', async (req: Request, res: Response) => {
    const lease = await broker.requestSession(parseRequest(BrowserSessionRequestSchema, req.body));
    res.status(201).json(projectBrowserSessionLease(lease));
  });

  /** @swagger
   * /api/browser-session-broker/sessions/{leaseId}/actions:
   *   post:
   *     summary: Use an active browser-session lease for one allowed action
   *     parameters:
   *       - { in: path, name: leaseId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local runner control validates the complete lease binding and exact action/origin policy before dispatch; browser internals and profile files are never returned."
   *     responses:
   *       200: { description: Bounded action result }
   *       403: { description: Action or navigation denied and redacted security evidence recorded }
   *       409: { description: Lease inactive, expired, or awaiting reconciliation }
   */
  router.post('/sessions/:leaseId/actions', async (req: Request, res: Response) => {
    const body = parseRequest(BrowserSessionUseBodySchema, req.body);
    const result = await broker.useSession({
      ...body,
      leaseId: parseRequest(z.string().uuid(), req.params.leaseId),
    });
    res.json(result);
  });

  /** @swagger
   * /api/browser-session-broker/authentication-requests/run/{runId}:
   *   get:
   *     summary: Read the latest durable browser authentication wait for a run
   *     parameters:
   *       - { in: path, name: runId, required: true, schema: { type: string } }
   *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local operator-only takeover metadata; exposes typed redacted observations but no profile, credential, browser endpoint, or model control."
   *     responses:
   *       200: { description: Latest authentication request or null }
   */
  router.get('/authentication-requests/run/:runId', async (req: Request, res: Response) => {
    const query = parseRequest(BrowserAuthenticationRunQuerySchema, req.query);
    const runId = parseRequest(z.string().trim().min(1).max(255), req.params.runId);
    const request = await broker.getAuthenticationRequestForRun(query.workspaceId, runId);
    res.json({ request: request ? projectBrowserAuthenticationRequest(request) : null });
  });

  /** @swagger
   * /api/browser-session-broker/authentication-requests/{requestId}/resolve:
   *   post:
   *     summary: Complete, cancel, or deny an operator browser authentication takeover
   *     parameters:
   *       - { in: path, name: requestId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local human authority only; completion is accepted solely after trusted runner observation proves the provider challenge cleared and session health."
   *     responses:
   *       200: { description: Typed resumed, terminal, or retryable authentication outcome }
   *       409: { description: Provider challenge remains visible or request state changed }
   *       503: { description: Runner termination or reconciliation remains uncertain }
   */
  router.post('/authentication-requests/:requestId/resolve', async (req: Request, res: Response) => {
    const operatorId = req.user?.id;
    if (typeof operatorId !== 'string' || operatorId.length === 0) {
      throw new ValidationError('Authenticated operator identity is required');
    }
    const request = await broker.resolveAuthentication(
      parseRequest(z.string().uuid(), req.params.requestId),
      parseRequest(BrowserAuthenticationResolutionSchema, req.body),
      operatorId,
    );
    res.json(projectBrowserAuthenticationRequest(request));
  });

  /** @swagger
   * /api/browser-session-broker/sessions/{leaseId}/revoke:
   *   post:
   *     summary: Revoke a browser-session lease and terminate its isolated runner
   *     parameters:
   *       - { in: path, name: leaseId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local authority-only revocation clears ephemeral runner state and applies the immutable profile retention policy."
   *     responses:
   *       200: { description: Revoked metadata-only lease }
   *       503: { description: Runner termination uncertain and reconciliation required }
   */
  router.post('/sessions/:leaseId/revoke', async (req: Request, res: Response) => {
    const body = parseRequest(BrowserSessionRevocationBodySchema, req.body);
    const lease = await broker.revokeSession({
      ...body,
      leaseId: parseRequest(z.string().uuid(), req.params.leaseId),
    });
    res.json(projectBrowserSessionLease(lease));
  });

  /** @swagger
   * /api/browser-session-broker/sessions/{leaseId}/reconcile:
   *   post:
   *     summary: Reconcile an uncertain or lost browser runner before profile reuse
   *     parameters:
   *       - { in: path, name: leaseId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local authority-only crash recovery confirms runner termination and persists newly observed provider/session health before releasing the profile fence."
   *     responses:
   *       200: { description: Reconciled metadata-only lease and health observation }
   *       409: { description: Lease is not awaiting reconciliation }
   *       503: { description: Termination or cleanup remains uncertain }
   */
  router.post('/sessions/:leaseId/reconcile', async (req: Request, res: Response) => {
    const body = parseRequest(BrowserSessionReconciliationBodySchema, req.body);
    const lease = await broker.reconcileSession({
      ...body,
      leaseId: parseRequest(z.string().uuid(), req.params.leaseId),
    });
    res.json(projectBrowserSessionLease(lease));
  });

  /** @swagger
   * /api/browser-session-broker/conformance/claude/journeys:
   *   post:
   *     summary: Start a real-Claude MCP conformance journey
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local operator-only issuance of a dedicated Claude profile lease and disposable bounded fixture; browser and OAuth material never crosses the route."
   *     x-rorca-mcp: false
   *     responses:
   *       201: { description: Exact journey state }
   *       403: { description: Broker/fixture disabled or profile/allowlist mismatch }
   *       409: { description: Lease or profile health fence rejected }
   */
  router.post('/conformance/claude/journeys', async (req: Request, res: Response) => {
    const journey = await dispatchClaudeMcpConformanceStart(req.body, claudeConformance);
    res.status(201).json({ journey });
  });

  /** @swagger
   * /api/browser-session-broker/conformance/claude/journeys/{journeyId}/advance:
   *   post:
   *     summary: Advance one fenced real-Claude consumer action
   *     parameters:
   *       - { in: path, name: journeyId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local operator-only progression of a fixed versioned UI contract; arbitrary selectors, prompts, tools, origins, and credentials are not accepted."
   *     x-rorca-mcp: false
   *     responses:
   *       200: { description: Updated journey or final redacted ExecutionReceipt }
   *       409: { description: Authentication, fixture, refresh, or revocation proof incomplete }
   */
  router.post('/conformance/claude/journeys/:journeyId/advance', async (req: Request, res: Response) => {
    res.json({ journey: await dispatchClaudeMcpConformanceAdvance(req.params.journeyId, claudeConformance) });
  });

  /** @swagger
   * /api/browser-session-broker/conformance/claude/runs/{runId}:
   *   get:
   *     summary: Read a Claude conformance journey and retained receipt
   *     parameters:
   *       - { in: path, name: runId, required: true, schema: { type: string } }
   *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local operator-only read of redacted UI/network hashes, fixture events, lease disposition, and revocation proof; evidence contains no credentials or OAuth values."
   *     x-rorca-mcp: false
   *     responses:
   *       200: { description: Journey or null }
   */
  router.get('/conformance/claude/runs/:runId', async (req: Request, res: Response) => {
    res.json({
      journey: await dispatchClaudeMcpConformanceRead(req.query, req.params.runId, claudeConformance),
    });
  });

  /** @swagger
   * /api/browser-session-broker/conformance/chatgpt/journeys:
   *   post:
   *     summary: Start a real-ChatGPT MCP conformance journey
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local operator-only issuance of a dedicated ChatGPT profile lease and disposable bounded fixture; browser and OAuth material never crosses the route."
   *     x-rorca-mcp: false
   *     responses:
   *       201: { description: Exact journey state }
   *       403: { description: Broker/fixture disabled or profile/allowlist mismatch }
   *       409: { description: Lease or profile health fence rejected }
   */
  router.post('/conformance/chatgpt/journeys', async (req: Request, res: Response) => {
    const journey = await dispatchChatGptMcpConformanceStart(req.body, chatGptConformance);
    res.status(201).json({ journey });
  });

  /** @swagger
   * /api/browser-session-broker/conformance/chatgpt/journeys/{journeyId}/advance:
   *   post:
   *     summary: Advance one fenced real-ChatGPT consumer action
   *     parameters:
   *       - { in: path, name: journeyId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local operator-only progression of the fixed ChatGPT UI contract; arbitrary selectors, prompts, tools, origins, and credentials are not accepted."
   *     x-rorca-mcp: false
   *     responses:
   *       200: { description: Updated journey or final redacted ExecutionReceipt }
   *       409: { description: Authentication, fixture, refresh, or revocation proof incomplete }
   */
  router.post('/conformance/chatgpt/journeys/:journeyId/advance', async (req: Request, res: Response) => {
    res.json({
      journey: await dispatchChatGptMcpConformanceAdvance(req.params.journeyId, chatGptConformance),
    });
  });

  /** @swagger
   * /api/browser-session-broker/conformance/chatgpt/runs/{runId}:
   *   get:
   *     summary: Read a ChatGPT conformance journey and retained receipt
   *     parameters:
   *       - { in: path, name: runId, required: true, schema: { type: string } }
   *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local operator-only read of redacted provider-difference/UI/network hashes, fixture events, isolation boundaries, lease disposition, and revocation proof."
   *     x-rorca-mcp: false
   *     responses:
   *       200: { description: Journey or null }
   */
  router.get('/conformance/chatgpt/runs/:runId', async (req: Request, res: Response) => {
    res.json({
      journey: await dispatchChatGptMcpConformanceRead(req.query, req.params.runId, chatGptConformance),
    });
  });

  /** @swagger
   * /api/browser-session-broker/profiles/enrollments:
   *   post:
   *     summary: Begin human enrollment of a dedicated provider test identity
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local operator-only creation of a browser profile binding; model and MCP callers must never control enrollment or receive profile material."
   *     responses:
   *       201: { description: Pending metadata-only enrollment and takeover state }
   *       400: { description: Invalid or secret-bearing request body }
   *       403: { description: Broker disabled or operator boundary denied }
   */
  router.post('/profiles/enrollments', async (req: Request, res: Response) => {
    const body = parseRequest(BrowserProfileEnrollmentMetadataSchema, req.body);
    const operatorId = req.user?.id;
    if (typeof operatorId !== 'string' || operatorId.length === 0) {
      throw new ValidationError('Authenticated operator identity is required');
    }
    const enrollment = await broker.beginEnrollment({ ...body, operatorId });
    res.status(201).json(projectBrowserProfileEnrollment(enrollment));
  });

  /** @swagger
   * /api/browser-session-broker/profiles/{bindingId}/quarantine:
   *   post:
   *     summary: Quarantine a browser profile and revoke its active leases
   *     parameters:
   *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local operator-only fail-closed profile quarantine; revokes active runner leases and preserves redacted evidence."
   *     responses:
   *       200: { description: Quarantined metadata-only profile binding }
   *       409: { description: Invalid lifecycle transition }
   */
  router.post('/profiles/:bindingId/quarantine', async (req: Request, res: Response) => {
    const body = parseRequest(BrowserProfileLifecycleRequestSchema, req.body);
    if (body.reason === 'operator_delete' || body.reason === 'retention_expired') {
      throw new ValidationError('Quarantine reason must describe quarantine or unhealthy state');
    }
    const binding = await broker.quarantineProfile(
      parseRequest(z.string().uuid(), req.params.bindingId),
      body.workspaceId,
      body.reason,
    );
    res.json(projectSettledBrowserProfile(binding));
  });

  /** @swagger
   * /api/browser-session-broker/profiles/{bindingId}:
   *   delete:
   *     summary: Destroy a browser profile and revoke its active leases
   *     parameters:
   *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local operator-only encrypted-profile destruction; authority metadata and redacted receipts remain retained and immutable."
   *     responses:
   *       200: { description: Deleted metadata-only profile binding }
   *       409: { description: Invalid lifecycle transition }
   */
  router.delete('/profiles/:bindingId', async (req: Request, res: Response) => {
    const body = parseRequest(BrowserProfileLifecycleRequestSchema, req.body);
    if (body.reason !== 'operator_delete' && body.reason !== 'retention_expired') {
      throw new ValidationError('Delete reason must be operator_delete or retention_expired');
    }
    const binding = await broker.deleteProfile(
      parseRequest(z.string().uuid(), req.params.bindingId),
      body.workspaceId,
      body.reason,
    );
    res.json(projectSettledBrowserProfile(binding));
  });

  /** @swagger
   * /api/browser-session-broker/profiles/{bindingId}/receipts:
   *   get:
   *     summary: Read retained redacted browser profile audit evidence
   *     parameters:
   *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
   *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Local operator-only read of append-only redacted profile evidence; no profile or authentication material is returned."
   *     responses:
   *       200: { description: Redacted append-only receipts }
   */
  router.get('/profiles/:bindingId/receipts', async (req: Request, res: Response) => {
    const query = parseRequest(BrowserProfileReceiptQuerySchema, req.query);
    const receipts = await findBrowserProfileReceipts(
      parseRequest(z.string().uuid(), req.params.bindingId),
      query.workspaceId,
    );
    res.json({ receipts });
  });

  return router;
}

export const browserSessionBrokerRouter = createBrowserSessionBrokerRouter();
export default browserSessionBrokerRouter;
