/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// Load environment variables before any other imports so module-level constants
// (e.g. GITHUB_CLIENT_ID in auth.ts) pick up the correct values.
import dotenv from 'dotenv';
import { applySelectedDbModeEnvironment, formatDbModeBootstrapLog } from './lib/db-strategy';

dotenv.config();
const dbModeBootstrap = applySelectedDbModeEnvironment();
if (dbModeBootstrap.changed) {
  console.info(formatDbModeBootstrapLog(dbModeBootstrap));
}

import {
  assertDispatchReceiverConfiguration,
  authRequired,
  getWorkspaceFilesystemCapability,
} from './lib/auth-utils';
import { createTrustedProxyPredicate } from './lib/trusted-proxy';

// Validate receiver-only authority before API initialization/listen. The worker
// never imports this entry point and must never possess the token.
if (process.env.NODE_ENV === 'production' && !process.env.JEST_WORKER_ID) {
  try {
    assertDispatchReceiverConfiguration();
    const workspaceFilesystem = getWorkspaceFilesystemCapability();
    if (!workspaceFilesystem.supported) {
      throw new Error(
        `Secure workspace filesystem capability unavailable: ${workspaceFilesystem.reason}`,
      );
    }
  } catch (error) {
    // Some legacy route imports install process-wide exception listeners. Exit
    // explicitly so they cannot convert invalid API authority into a zero exit.
    console.error(error);
    process.exit(1);
  }
}

// Patch Express 4 before importing modules that register async route handlers.
import './lib/async-handler';
import './lib/eco-structured-bootstrap';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import type { Server } from 'http';
import path from 'path';
import workspacesRouter from './routes/workspaces';
import directionRouter from './routes/direction';
import specsRouter from './routes/specs';
import specJobsRouter from './routes/spec-jobs';
import walRouter from './routes/wal';
import contextRouter from './routes/context';
import contextEventsRouter from './routes/context-events';
import contextEventsLegacyRouter from './routes/context-events-legacy';
import contextCandidatesRouter from './routes/context-candidates';
import contextCaptureRouter from './routes/context-capture';
import captureIngestRouter from './routes/capture-ingest';
import pipelineRouter, { cleanupOldLogs, cleanupOrphanRuns } from './routes/pipeline';
import ptyEvidenceRouter from './routes/pty-evidence';
import ptyOperationsRouter from './routes/pty-operations';
import recoveryRouter from './routes/recovery';
import closeoutReconciliationPublicRouter from './routes/closeout-reconciliation-public';
import hooksRouter from './routes/hooks';
import worktreesRouter from './routes/worktrees';
import templatesRouter from './routes/templates';
import storiesRouter from './routes/stories';
import schedulesRouter from './routes/schedules';
import envVarsRouter from './routes/env-vars';
import webhooksRouter, { webhookAdminRouter } from './routes/webhooks';
import forgejoWebhookCallbackRouter from './routes/forgejo-webhooks';
import forgejoOperatorRouter from './routes/forgejo-operator';
import providerBindingsRouter from './routes/provider-bindings';
import operationIntentsRouter from './routes/operation-intents';
import browserSessionBrokerRouter from './routes/browser-session-broker';
import browserMcpConformanceFixtureRouter from './routes/browser-mcp-conformance-fixture';
import githubChecksRouter from './routes/github-checks';
import workspaceGithubRouter from './routes/workspace-github';
import workspaceGithubAppRouter from './routes/workspace-github-app';
import stripeCredentialCeremoniesRouter from './routes/stripe-credential-ceremonies';
import activityRouter from './routes/activity';
import analyticsRouter from './routes/analytics';
import budgetRouter from './routes/budget';
import finopsSettingsRouter from './routes/finops-settings';
import usersRouter from './routes/users';
import authRouter from './routes/auth';
import piAuthRouter from './routes/pi-auth';
import onboardingRouter from './routes/onboarding';
import backupsRouter from './routes/backups';
import healthRouter from './routes/health';
import doctorRouter from './routes/doctor';
import versionRouter from './routes/version';
import { startScheduler } from './lib/scheduler';
import { registerWebhookHandlers } from './routes/webhook-handlers';
import agentHooksRouter from './routes/agent-hooks';
import agentProfilesRouter from './routes/agent-profiles';
import notificationsRouter from './routes/notifications';
import settingsRouter from './routes/settings';
import { fireAgentHooks } from './lib/agent-hook-runner';
import { startNotificationDispatcher } from './lib/notification-dispatcher';
import { startQueueConsumer } from './lib/queue-consumer';
import { startMemorySynthesis } from './lib/memory-synthesis';
import { startFileWatcher } from './lib/file-watcher';
import { startEmbeddingPipeline } from './lib/embedding-pipeline';
import { startWalListener, stopWalListener } from './lib/wal-listener';
import { startRunOutputListener, stopRunOutputListener } from './lib/run-output-listener';
import { startRunFailureWatchdogFromEnv } from './lib/run-failure-watchdog';
import { subscribe, type WalEvent } from './lib/sse-hub';
import { rotateMemory } from './lib/memory-ledger';
import { deduplicateMemory } from './lib/memory-dedup';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './lib/swagger';
import { rateLimiter, initRateLimiterCache } from './lib/rate-limiter';
import { operatorReviewRouter, publicReviewRouter, specReviewRouter } from './routes/review';
import fileWatchRouter from './routes/file-watch';
import { errorHandler } from './lib/error-handler';
import { csrfProtection } from './lib/csrf';
import {
  isConfiguredLocalOrigin,
  requireConfiguredBrowserOrigin,
  requireLocalOperatorBoundary,
} from './lib/local-operator-boundary';
import { queryTimerMiddleware, runQueryPlanAudit } from './lib/query-timer';
import { queryOne } from './db/index';
import runQueueRouter from './routes/run-queue';
import configRouter from './routes/config';
import vaultRouter from './routes/vault';
import openRouterAuthorityRouter from './routes/openrouter-authority';
import memoryRouter from './routes/memory';
import memoryCandidatesRouter from './routes/memory-candidates';
import crossWorkspaceMemoryRouter from './routes/cross-workspace-memory';
import agentsRouter from './routes/agents';
import contextRoutingRouter from './routes/context-routing';
import contextFilesRouter from './routes/context-files';
import conventionsRouter from './routes/conventions';
import packsRouter from './routes/packs';
import skillsRouter from './routes/skills';
import personasRouter from './routes/personas';
import marketplaceRouter from './routes/marketplace';
import searchRouter from './routes/search';
import recallRouter from './routes/recall';
import operatorChatRouter from './routes/operator-chat';
import eventsRouter from './routes/events';
import candidatesRouter from './routes/candidates';
import { agentType } from './lib/config';
import { requireOpenCode } from './lib/opencode-detector';
import { buildMcpToolTierResolver, createMcpRequestHandler, getMcpToolDefinitions } from './lib/mcp-http';
import { RORCA_JSON_BODY_LIMIT } from './lib/http-body-limit';
import telemetryRouter from './routes/telemetry';
import authE2ERouter from './routes/auth-e2e';
import { logger } from './lib/logger';
import pinoHttp from 'pino-http';
import { startGraphPopulator } from './lib/graph-populator';
import { startGraphContextCacheInvalidator } from './lib/graph-context';
import workspaceDriftRouter from './routes/workspace-drift';
import graphRouter from './routes/graph';
import specRelevanceGraphRouter from './routes/spec-relevance-graph';
import workflowRouterRouter from './routes/workflow-router';
import gitReinsEvidenceRouter from './routes/gitreins-evidence';
import { startDriftSubscriber } from './lib/drift-subscriber';
import { startMarkerInjector } from './lib/marker-injector';
import { StoryLogFollower } from './lib/story-log-follower';
import { startCheckRunPoster } from './lib/check-run-poster';
import { startForgejoCheckPoster } from './lib/forgejo-check-poster';
import attachmentsRouter from './routes/attachments';
import retrievalTracesRouter from './routes/retrieval-traces';
import { awaitRequiredStartupReadiness, terminateFailedStartup } from './lib/startup-readiness';
import hydrationRouter from './routes/hydration';
import diagnosticsRouter from './routes/diagnostics';
import mcpToolsRouter from './routes/mcp-tools';
import executionEnvironmentsRouter from './routes/execution-environments';
import { initBoss, stopBoss } from './lib/pg-boss';
import { recoverPendingDispatchPublications } from './lib/dispatch-publication';
import {
  ensureMcpToken,
  isAllowedMcpOrigin,
  MCP_ALLOWED_ORIGINS,
  requireLocalhost,
  requireMcpAuth,
} from './lib/mcp-auth';
import { summarizeRorcaTiers } from './lib/tier-auth';
import { planGate } from './lib/plan-gate';
import lifecycleRouter from './routes/lifecycle';
import lifecycleEvidenceRouter from './routes/lifecycle-evidence';
import hermesWatchdogRouter from './routes/hermes-watchdog';
import hermesIntentRouter from './routes/hermes-intent';
import hermesMissionDraftRouter from './routes/hermes-mission-draft';
import lifecycleDecisionsRouter from './routes/lifecycle-decisions';
import lifecycleMutationsRouter from './routes/lifecycle-mutations';
import lifecycleReconciliationRouter from './routes/lifecycle-reconciliation';
import preStagingQualificationRouter from './routes/pre-staging-qualification';
import supabaseCredentialCeremoniesRouter from './routes/supabase-credential-ceremonies';
import deliveryGovernanceRouter from './routes/delivery-governance';
import genesisRouter from './routes/genesis';
import deliveryRouter from './routes/delivery';
import missionControlRouter from './routes/mission-control';
import federatedRuntimeRouter from './routes/federated-runtime';
import attentionRouter from './routes/attention';
import deliveryCasesRouter from './routes/delivery-cases';
import waveQualificationRouter from './routes/wave-qualification';
import bountyPolicyRouter from './routes/bounty-policy';
import executionAuthorityRouter from './routes/execution-authority';
import bountyCredentialsRouter from './routes/bounty-credentials';
import bountyWorkPackagesRouter from './routes/bounty-work-packages';
import bountyReflectionsRouter from './routes/bounty-reflections';
import bountyMissionControlRouter from './routes/bounty-mission-control';
import bountyRouter from './routes/bounty';
import bountyPresentationRouter from './routes/bounty-presentation';
import bountySessionsRouter from './routes/bounty-sessions';
import { reconcileAllBountyMissionsOnRestart } from './lib/bounty-mission-control';
import { startSsdlcEvidenceNormalizer } from './lib/ssdlc-evidence-subscriber';
import { randomUUID } from 'crypto';
import { reconcileInterruptedRawPtyArchives } from './lib/pty-raw-archive';


// OC-002: Fail-fast if RORCA_AGENT=opencode but binary is missing
if (agentType === 'opencode') {
  requireOpenCode();
}

const app = express();
// Canonical API paths are case-sensitive and do not accept an implicit trailing
// slash. Security boundaries and Express therefore share one routing contract.
app.enable('case sensitive routing');
app.set('trust proxy', createTrustedProxyPredicate());
app.enable('strict routing');
const PORT = process.env.PORT || 3030;
const BACKGROUND_RUNTIME_ENABLED =
  process.env.NODE_ENV !== 'test' &&
  process.env.RORCA_DISABLE_BACKGROUND_RUNTIME !== 'true';
const STORY_LOG_FOLLOWER_ENABLED =
  BACKGROUND_RUNTIME_ENABLED &&
  process.env.RORCA_DISABLE_STORY_LOG_FOLLOWER !== 'true';
const MCP_HTTP_ENABLED = process.env.RORCA_SERVE_MCP !== 'false';

// US-038: Request ID middleware — injects trace/correlation ID for every request.
// Uses the X-Request-Id header if present, otherwise generates a short UUID.
app.use((req, _res, next) => {
  (req as any).requestId = (req.headers['x-request-id'] as string) || `req-${randomUUID().slice(0, 8)}`;
  next();
});

// US-038: pino-http logger with request ID on every request
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => (req.headers['x-request-id'] as string) || `req-${randomUUID().slice(0, 8)}`,
    autoLogging: {
      ignore: (req) => req.url === '/api/health',
    },
    customProps: (req) => ({
      requestId: (req as any).requestId,
    }),
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        requestId: (req as any).requestId,
      }),
    },
  }),
);

// Disable ETags on API responses — prevents browsers from caching 404s and replaying
// stale error responses after backend state changes (workspace renames, schema fixes, etc.).
app.set('etag', false);
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Local single-user CORS is exact and deny-by-default. CORS headers alone do
// not stop forged browser requests, so reject unconfigured Origin values before
// routing as well.
app.use(requireConfiguredBrowserOrigin);
app.use(cors({
  origin: (origin, callback) => callback(null, origin !== undefined && isConfiguredLocalOrigin(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Workspace-Id', 'X-Rorca-Admin-Key', 'X-Rorca-Operator-Capability', 'Idempotency-Key', 'X-Rorca-Runtime-Id'],
  maxAge: 86400,
}));

// Capture raw bytes only for exact provider callback paths. Protected webhook
// administration is deliberately not part of this signature/CSRF exemption.
const WEBHOOK_CALLBACK_PATHS = new Set([
  '/api/webhooks/github',
  '/api/webhooks/forgejo',
  '/api/webhooks/linear',
  '/api/webhooks/vercel',
  '/api/webhooks/slack',
]);
// One megabyte safely covers the bounded 512 KiB TaskManifest/context contract
// while retaining the incoming mainline fix that removes Express's 100 KiB default.
const defaultJsonParser = express.json({
  limit: RORCA_JSON_BODY_LIMIT,
  verify: (req, _res, buf) => {
    const url = (req as express.Request).originalUrl || '';
    const callbackPath = url.split('?', 1)[0];
    if (WEBHOOK_CALLBACK_PATHS.has(callbackPath)) {
      (req as any).rawBody = buf;
    }
  },
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api/mission-control/v1/')) return next();
  defaultJsonParser(req, res, next);
});

// PR-006: HTTP security headers via helmet
// Apply after CORS/body parsers and before all route mounts.
const httpsEnabled = process.env.NODE_ENV === 'production';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'http:', 'https:'],
      formAction: ["'self'", 'https://github.com'],
      upgradeInsecureRequests: httpsEnabled ? [] : null,
    },
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  hsts: httpsEnabled ? { maxAge: 31536000, includeSubDomains: true } : false,
  xssFilter: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permittedCrossDomainPolicies: false,
}));
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// V2-099: Query timing middleware — logs requests taking >100ms
app.use(queryTimerMiddleware);

// ─── Public routes (no auth required) ───
app.use('/api/health', healthRouter);
app.use('/api/version', versionRouter);

if (process.env.NODE_ENV === 'test') {
  app.use('/api/test/auth', authE2ERouter);
}
app.use('/api/telemetry', telemetryRouter);

app.get('/api/docs/openapi.json', (_req, res) => {
  res.json(swaggerSpec);
});
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  explorer: true,
  customSiteTitle: 'Rorca API Docs',
}));

// Rate limit public routes by IP (unauthenticated tier)
app.use('/api/auth', rateLimiter, authRouter);
// Exact provider callbacks only. The GitHub Manifest browser callback remains the
// static GET /settings/github route; credential exchange stays protected below.
app.use('/api/webhooks', webhooksRouter);
app.use('/api/webhooks/forgejo', forgejoWebhookCallbackRouter);
// Share-token reads remain public; guest comments additionally require the
// same double-submit CSRF proof as authenticated mutations.
app.use('/api/review', rateLimiter, csrfProtection, publicReviewRouter);
// Disposable, random-ID OAuth/MCP test fixture. The registry is off by default
// and every protocol request is fenced to one Claude test client and subject.
app.use('/browser-conformance', rateLimiter, browserMcpConformanceFixtureRouter);
if (BACKGROUND_RUNTIME_ENABLED) {
  registerWebhookHandlers();
}

// CA-021: MCP Streamable HTTP transport — auto-generated from OpenAPI spec
// MCP clients (Claude Code, IDE extensions) connect over HTTP without browser
// origin headers. Scoped CORS on /mcp only — no credentials, session-id header
// allowed, and browser access is restricted to same-origin localhost tools.
// CORS rejection is handled by the cors package callback and bubbles into the
// generic Express error path rather than the JSON error schema used elsewhere.
const mcpCors = cors({
  origin: (origin, callback) => {
    if (isAllowedMcpOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin not allowed: ${origin}`));
  },
  credentials: false,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Mcp-Session-Id', 'Authorization'],
  exposedHeaders: ['Mcp-Session-Id'],
  maxAge: 86400,
});

const NO_OAUTH_RESPONSE = {
  error: 'OAuth not supported',
  message: 'Rorca uses Bearer token authentication, not OAuth. See ~/.rorca/mcp-token.',
  documentation: 'Run `rorca mcp setup-claude` to configure your MCP client.',
};

for (const oauthPath of [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/register',
  '/register',
]) {
  app.all(oauthPath, (_req, res) => res.status(501).json(NO_OAUTH_RESPONSE));
}

if (MCP_HTTP_ENABLED) {
  const mcpHandlers = createMcpRequestHandler(swaggerSpec as any);
  const mcpToolTierResolver = buildMcpToolTierResolver(swaggerSpec as any);
  logger.info({ origins: MCP_ALLOWED_ORIGINS }, '[MCP Aegis] HTTP transport locked to localhost browser origins by default');
  app.post('/mcp', mcpCors, requireLocalhost, requireMcpAuth('public', mcpToolTierResolver), mcpHandlers.handlePost);
  app.get('/mcp', mcpCors, requireLocalhost, requireMcpAuth(), mcpHandlers.handleGet);
  app.delete('/mcp', mcpCors, requireLocalhost, requireMcpAuth(), mcpHandlers.handleDelete);
}

// MC-004: MCP Tools enumeration endpoint (public — used by VS Code extension, no auth required)
app.use('/api/mcp/tools', mcpToolsRouter);

// US-007: Genesis bridge endpoint — read-only principal-aware canonical context resolution
app.use('/api/genesis', rateLimiter, genesisRouter);

// Serve static frontend files before auth so assets/favicon load for unauthenticated users
if (process.env.RORCA_SERVE_STATIC === '1' && process.env.RORCA_STATIC_DIR) {
  const staticDir = process.env.RORCA_STATIC_DIR;
  app.use(express.static(staticDir));
  // SPA fallback: serve index.html for non-API, non-MCP routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/mcp')) return next();
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

// The federated runtime authenticates with its own bounded Federated credential.
// Mount it before browser auth, user rate limiting, CSRF, and the 4 MiB
// mission-control parser; the child router enforces TLS, 256 KiB, and its own rate window.
app.use('/api/mission-control/v1/federation', federatedRuntimeRouter);

// ─── Auth middleware (all routes below require authentication) ───
// The same resolver runs in both shipped topologies. In local mode an omitted
// credential becomes LOCAL_ADMIN, but a supplied Bearer/internal credential is
// always validated and classified before that human fallback.
app.use(authRequired);

// ─── Rate limiting (after auth so req.user is available) ───
app.use(rateLimiter);

// ─── CSRF protection (double-submit cookie pattern) ───
// Validates X-CSRF-Token header against _csrf cookie on POST/PUT/PATCH/DELETE.
// Exempt: exact provider callbacks, MCP, docs, health, and CSRF bootstrap.
app.use(csrfProtection);
// Host-sensitive local operator routes require auth, rate limits, CSRF for
// mutations, a loopback peer, an exact configured Origin (when present), and
// the explicit operator capability in local mode.
app.use('/api/doctor', doctorRouter);
app.use('/api/forgejo', forgejoOperatorRouter);
app.use('/api/authority', providerBindingsRouter);
app.use('/api/authority', operationIntentsRouter);
app.use('/api/browser-session-broker', browserSessionBrokerRouter);
app.use('/api/review', operatorReviewRouter);
// Default-denied/MCP-excluded webhook administration requires platform +
app.use('/api/pi/auth', requireLocalOperatorBoundary, piAuthRouter);
// workspace authorization in the router. It mounts after auth/CSRF but before
// planGate so default-denied native routes remain callable only here, never MCP.
app.use('/api/webhooks', webhookAdminRouter);
app.use(planGate());

// ─── Protected routes ───
app.use('/api/workspaces', workspacesRouter);
app.use('/api/workspace', fileWatchRouter);
app.use('/api/direction', directionRouter);
app.use('/api/specs', specsRouter);
app.use('/api/spec-jobs', specJobsRouter);
// EQ-007: Review link creation (auth-protected, mounted under /api/specs)
app.use('/api/specs', specReviewRouter);
app.use('/api/wal', walRouter);
app.use('/api/context', contextRouter);
app.use('/api/context-events', contextEventsLegacyRouter);
app.use('/api/context-events', contextEventsRouter);
app.use('/api/context-candidates', contextCandidatesRouter);
app.use('/api/context-capture', contextCaptureRouter);
app.use('/api/workspaces', captureIngestRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/pty-evidence', ptyEvidenceRouter);
app.use('/api/pty-operations', ptyOperationsRouter);
// Admin-only and deliberately absent from MCP/OpenAPI tool generation.
app.use('/api/recovery', closeoutReconciliationPublicRouter);
app.use('/api/admin/recovery', recoveryRouter);
app.use('/api/admin/wave-qualification', waveQualificationRouter);
app.use('/api/admin/execution-authority', executionAuthorityRouter);
app.use('/api/admin/bounty', bountyPolicyRouter);
app.use('/api/admin/bounty', bountyReflectionsRouter);
app.use('/api/admin/bounty/credentials', bountyCredentialsRouter);
app.use('/api/admin/bounty/work-packages', bountyWorkPackagesRouter);
app.use('/api/admin/bounty/missions', bountyMissionControlRouter);
app.use('/api/admin/bounty/sessions', bountySessionsRouter);
// Dedicated human-Controller adapter. Target-effect IPC and submission are intentionally absent.
app.use('/api/bounty', bountyRouter);
// Read-only OpenAPI projection for MCP/Pi/Hermes; it grants no Controller authority.
app.use('/api/contracts/bounty-presentation', bountyPresentationRouter);
app.use('/api/execution-environments', executionEnvironmentsRouter);
app.use('/api/pipeline/hooks', hooksRouter);
app.use('/api/pipeline/schedules', schedulesRouter);
app.use('/api/worktrees', worktreesRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/stories', storiesRouter);
app.use('/api/workspaces/:id/env-vars', envVarsRouter);
app.use('/api/workspaces/:id/budget', budgetRouter);
app.use('/api/workspaces/:id/agent-hooks', agentHooksRouter);
app.use('/api/workspaces/:id/agent-profiles', agentProfilesRouter);
app.use('/api/workspaces', workspaceDriftRouter);
// Provider-facing mutations attach the capability boundary on each exact route
// before its handler. Autonomous children cannot turn localhost access into host
// App/PAT/vault authority; command wrappers are defense in depth only.
app.use('/api/workspaces', workspaceGithubRouter);
app.use('/api/workspaces', workspaceGithubAppRouter);
app.use('/api/workspaces', stripeCredentialCeremoniesRouter);
app.use('/api/workspaces', deliveryGovernanceRouter);
app.use('/api/workspaces', attentionRouter);
app.use('/api/workspaces', deliveryCasesRouter);
// Provider-neutral local delivery is the canonical default. GitHub routes above
// remain available only as an explicit optional provider integration.
app.use('/api/delivery', deliveryRouter);
app.use('/api/mission-control/v1', missionControlRouter);
app.use('/api/github/checks', githubChecksRouter);
app.use('/api/activity', activityRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/finops/billing-profiles', finopsSettingsRouter);
app.use('/api/users', usersRouter);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/admin', backupsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/run-queue', runQueueRouter);
app.use('/api/config', configRouter);
app.use('/api/vault', vaultRouter);
app.use('/api/supabase/credential-ceremonies', supabaseCredentialCeremoniesRouter);
app.use('/api/openrouter-authority', openRouterAuthorityRouter);
app.use('/api/memory/candidates', memoryCandidatesRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/memory/cross-workspace', crossWorkspaceMemoryRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/workspaces', contextRoutingRouter);
app.use('/api/workspaces', contextFilesRouter);
app.use('/api/workspaces', hydrationRouter);
app.use('/api/conventions', conventionsRouter);
app.use('/api/packs', packsRouter);
app.use('/api/skills', skillsRouter);
app.use('/api/attachments', attachmentsRouter);
app.use('/api/personas', personasRouter);
app.use('/api/marketplace', marketplaceRouter);
app.use('/api/search', searchRouter);
app.use('/api/recall', recallRouter);
app.use('/api/operator-chat', operatorChatRouter);
app.use('/api/events', eventsRouter);
app.use('/api/candidates', candidatesRouter);
app.use('/api/graph', graphRouter);
app.use('/api/spec-relevance-graph', specRelevanceGraphRouter);
app.use('/api/workflow-router', workflowRouterRouter);
app.use('/api/retrieval-traces', retrievalTracesRouter);
app.use('/api/diagnostics', diagnosticsRouter);
app.use('/api/gitreins', gitReinsEvidenceRouter);
app.use('/api/lifecycle', lifecycleRouter);
app.use('/api/lifecycle', lifecycleEvidenceRouter);
app.use('/api/hermes/intent', hermesIntentRouter);
app.use('/api/hermes/mission-draft', hermesMissionDraftRouter);
app.use('/api/hermes/watchdog', hermesWatchdogRouter);
app.use('/api/lifecycle', lifecycleDecisionsRouter);
app.use('/api/lifecycle', lifecycleMutationsRouter);
app.use('/api/lifecycle', lifecycleReconciliationRouter);
app.use('/api/lifecycle', preStagingQualificationRouter);

// V2-094: Centralized error handler (must be after all routes)
app.use(errorHandler);

const storyLogFollower = new StoryLogFollower();

// Per-subscriber kill switches. Subscribers that share the request pool and
// perform heavy WAL-driven work (graph, embeddings, log tailing, synthesis)
// can be disabled individually while keeping lifecycle-critical automation
// (pg-boss, queue consumer, failure watchdog, WAL/run-output listeners) alive.
const bgDisabled = (name: string): boolean =>
  process.env[`RORCA_DISABLE_${name}`] === 'true';

if (BACKGROUND_RUNTIME_ENABLED) {
  // V2-069: Subscribe agent hook runner to all WAL broadcasts
  if (!bgDisabled('AGENT_HOOKS')) subscribe(fireAgentHooks);

  // V2-073: Subscribe notification dispatcher to WAL broadcasts
  if (!bgDisabled('NOTIFICATION_DISPATCHER')) startNotificationDispatcher();

  // US-034: Subscribe draft PR lifecycle to update PR body on story completions
  // Draft/PR provider mutations are terminal release effects owned by the worker seam.

  // RQ-002: Subscribe queue consumer to auto-trigger next run on completion
  if (!bgDisabled('QUEUE_CONSUMER')) startQueueConsumer();

  // CIE-005: Subscribe memory synthesis to generate ledger entries after successful runs
  if (!bgDisabled('MEMORY_SYNTHESIS')) startMemorySynthesis();

  // PG-007: Subscribe embedding pipeline to WAL events for automatic vector generation
  if (!bgDisabled('EMBEDDING_PIPELINE')) startEmbeddingPipeline();

  // PG-015: Subscribe graph populator to WAL events for knowledge graph edges
  if (!bgDisabled('GRAPH_POPULATOR')) startGraphPopulator();
  if (!bgDisabled('GRAPH_CONTEXT_CACHE_INVALIDATOR')) startGraphContextCacheInvalidator();

  // PG-017: Subscribe drift detector to WAL events for post-run convention drift analysis
  if (!bgDisabled('DRIFT_SUBSCRIBER')) startDriftSubscriber();

  // US-008: Subscribe marker injector to write story completion markers into run_output_chunks
  if (!bgDisabled('MARKER_INJECTOR')) startMarkerInjector();

  // US-004: Subscribe story-log-follower to tail story logs and write prose to story_output_chunks
  if (STORY_LOG_FOLLOWER_ENABLED && !bgDisabled('STORY_LOG_FOLLOWER')) storyLogFollower.start();

  // US-027: Subscribe commit status poster to post GitHub status checks for story progress

  // US-030: Subscribe check run poster to manage GitHub Check Runs for pipeline runs
  if (!bgDisabled('CHECK_RUN_POSTER')) startCheckRunPoster();
  // W5-004: Subscribe the restart-safe Forgejo commit-status projector from
  // the production bootstrap (live-head resolution for running events).
  if (!bgDisabled('FORGEJO_CHECK_POSTER')) startForgejoCheckPoster();

  // LFC-005: Normalize run/story evidence as an isolated immutable side-write.
  if (!bgDisabled('SSDLC_EVIDENCE_NORMALIZER')) startSsdlcEvidenceNormalizer();

  // PR-019: Auto-rotate memory after each pipeline run completion
  // PR-018: Auto-deduplicate memory after rotation (post-run)
  if (!bgDisabled('POST_RUN_MEMORY_ROTATION')) {
    subscribe((event: WalEvent) => {
      if (event.event_type !== 'run_finished' || !event.workspace_id) return;
      const workspaceId = event.workspace_id;
      (async () => {
        try {
          const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
          if (!ws) return;
          rotateMemory(ws.path);
          // Run dedup after rotation — removes semantically duplicate entries
          await deduplicateMemory(ws.path, workspaceId);
        } catch {
          // Non-fatal — rotation/dedup failure must not affect the run result
        }
      })();
    });
  }
}

/* istanbul ignore next -- only when run directly, not in tests */
if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  // Safety net: log unhandled rejections instead of crashing the process.
  // Routes should handle their own errors, but this prevents a single bad request
  // from taking down the entire backend. Test imports must never mutate process-
  // global listener state, especially when Jest reloads the server module.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, '[UnhandledRejection] Caught — process kept alive');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, '[UncaughtException] Caught — process kept alive');
  });
  const tierSummary = summarizeRorcaTiers(swaggerSpec as any);
  const mcpToolDefinitions = getMcpToolDefinitions(swaggerSpec as any);
  logger.info(`[Rorca Tier] Route exposure: ${tierSummary.public} public, ${tierSummary.auth} auth, ${tierSummary.paid} paid, ${tierSummary.admin} admin (${tierSummary.denied} default-denied)`);
  logger.info(`[Rorca Tier] MCP exposure: ${mcpToolDefinitions.length} tools (public + auth only)`);
  logger.info(`[Rorca Tier] Open-source CLI surface: ${tierSummary.publicApi} routes (public + public-api flagged)`);

  if (MCP_HTTP_ENABLED) {
    const { publicCreated, adminCreated } = ensureMcpToken();
    if (publicCreated || adminCreated) {
      logger.info('[MCP Aegis] Ensured MCP public token at ~/.rorca/mcp-token and admin token at ~/.rorca/mcp-admin-token (mode 0600)');
      logger.info('[MCP Aegis] Run `rorca mcp setup-claude` for public access or `rorca mcp setup-claude --admin` for admin access');
    } else {
      logger.info('[MCP Aegis] Loaded existing MCP public/admin tokens');
    }
  }

  // BL-013: Log license status at startup
  (() => {
    const envLicenseKey = process.env.RORCA_LICENSE_KEY;
    if (envLicenseKey) {
      try {
        const { verifyLicense: verify } = require('./lib/license-verifier');
        const license = verify(envLicenseKey);
        const expiresInfo = license.exp
          ? `expires ${new Date(license.exp * 1000).toISOString().split('T')[0]}`
          : 'perpetual';
        logger.info(`License: self-hosted (RORCA_LICENSE_KEY) — plan=${license.plan}, ${expiresInfo}`);
      } catch (err: any) {
        logger.warn(`License: RORCA_LICENSE_KEY set but invalid — ${err.message || 'verification failed'}`);
      }
    } else {
      logger.info('License: OSS local-first mode');
    }
  })();

  // OCT-021: Bind HTTP only after transport registration and durable recovery.
  // Until this barrier succeeds there is deliberately no readiness listener:
  // callers cannot observe a healthy control plane over stale queue/run state.
  const bindHost = process.env.RORCA_BIND_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  const listenPort = Number(PORT);
  let httpServer: Server | null = null;
  const startHttpServer = async (): Promise<void> => {
    if (BACKGROUND_RUNTIME_ENABLED) {
      const { publicationRecovery: recovery } = await awaitRequiredStartupReadiness({
        initializeTransport: initBoss,
        recoverPublications: recoverPendingDispatchPublications,
        cleanupOrphanRuns,
        recoverStoryLogs: () => STORY_LOG_FOLLOWER_ENABLED
          ? storyLogFollower.recover()
          : Promise.resolve(),
      });
      if (recovery.scanned > 0) {
        logger.info({ recovery }, '[pipeline-dispatch] startup publication recovery complete');
      }
      const archiveCount = await reconcileInterruptedRawPtyArchives();
      if (archiveCount > 0) {
        logger.info({ count: archiveCount }, '[pty-archive] Reconciled interrupted archives');
      }
      const bountyResults = await reconcileAllBountyMissionsOnRestart();
      const changed = bountyResults.filter((result) => result.cancelledPreparedEffects
        || result.uncertainEffects || result.staleOutbox || result.staleLeases || result.staleProcesses);
      if (changed.length > 0) {
        logger.info({ missions: changed.length, results: changed }, '[bounty] Startup mission reconciliation complete');
      }
      await cleanupOldLogs();
      await startFileWatcher();
      startScheduler();
      startWalListener();
      startRunOutputListener();
    } else {
      // Request-only control-plane processes still publish dispatch jobs.
      // Disable subscribers and recovery, not the durable pg-boss transport.
      await initBoss();
      logger.info('[server] Background subscribers disabled for this process');
    }

    httpServer = app.listen(listenPort, bindHost, () => {
      logger.info(`Rorca backend listening on ${bindHost}:${PORT}`);
      initRateLimiterCache().catch(err => logger.error({ err }, '[RateLimiter] Cache init failed'));
      runQueryPlanAudit().catch(err => logger.error({ err }, '[QueryAudit] Startup audit failed'));
      queryOne('SELECT id FROM workspaces LIMIT 1').then(row => {
        if (!row) logger.warn('[StartupCheck] No workspaces found — onboarding will show');
        else logger.info({ id: (row as any).id }, '[StartupCheck] Workspace query OK — search_path verified');
      }).catch(err => logger.error({ err }, '[StartupCheck] Workspace query FAILED — search_path may be wrong'));
      if (BACKGROUND_RUNTIME_ENABLED) {
        // Run-failure watchdog: lives in the API (outlives every worker),
        // restarts a dead worker and re-drives worker-interrupted runs.
        startRunFailureWatchdogFromEnv(listenPort);
      }
    });
  };
  void startHttpServer().catch(async (err) => {
    logger.error({ err }, '[server] Startup readiness barrier failed; HTTP listener not opened');
    await terminateFailedStartup({
      stopResources: async () => {
        storyLogFollower.stop();
        await stopBoss();
      },
      terminate: code => process.exit(code),
    });
  });
  let shuttingDown = false;
  const shutdown = async (signal: 'SIGTERM' | 'SIGINT') => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, '[server] Graceful shutdown started');
    // SSE and upgraded MCP streams can outlive HTTP close indefinitely. Exit
    // before launchd's five-second deadline so tsx cannot orphan this process.
    const deadline = setTimeout(() => {
      logger.warn({ signal }, '[server] Shutdown deadline reached; closing remaining streams');
      httpServer?.closeAllConnections();
      process.exit(0);
    }, 4_000);
    deadline.unref();
    await Promise.all([stopRunOutputListener(), stopWalListener()]);

    if (!httpServer) {
      process.exit(0);
      return;
    }
    httpServer.close(() => {
      logger.info({ signal }, '[server] HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

export default app;
