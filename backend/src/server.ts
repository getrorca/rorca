/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

// Load environment variables before any other imports so module-level constants
// (e.g. GITHUB_CLIENT_ID in auth.ts) pick up the correct values.
import dotenv from 'dotenv';
dotenv.config();

// Patch Express 4 to catch async route handler rejections — must be first import
import './lib/async-handler';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import workspacesRouter from './routes/workspaces';
import directionRouter from './routes/direction';
import specsRouter from './routes/specs';
import specJobsRouter from './routes/spec-jobs';
import walRouter from './routes/wal';
import contextRouter from './routes/context';
import pipelineRouter, { cleanupOldLogs, cleanupOrphanRuns } from './routes/pipeline';
import hooksRouter from './routes/hooks';
import worktreesRouter from './routes/worktrees';
import templatesRouter from './routes/templates';
import storiesRouter from './routes/stories';
import schedulesRouter from './routes/schedules';
import envVarsRouter from './routes/env-vars';
import workspaceGithubRouter from './routes/workspace-github';
import workspaceIntegrationsRouter from './routes/workspace-integrations';
import integrationAuditLogRouter from './routes/integration-audit-log';
import webhooksRouter from './routes/webhooks';
import githubChecksRouter from './routes/github-checks';
import teamsRouter from './routes/teams';
import invitesRouter from './routes/invites';
import activityRouter from './routes/activity';
import analyticsRouter from './routes/analytics';
import budgetRouter from './routes/budget';
import vaultRouter from './routes/vault';
import usersRouter from './routes/users';
import authRouter from './routes/auth';
import { authRequired, LOCAL_ADMIN, resolveAuthUserFromToken } from './lib/auth-utils';
import { supabaseAdmin } from './lib/supabase';
import onboardingRouter from './routes/onboarding';
import backupsRouter from './routes/backups';
import healthRouter from './routes/health';
import doctorRouter from './routes/doctor';
import versionRouter from './routes/version';
import { startScheduler } from './lib/scheduler';
import { registerWebhookHandlers } from './routes/webhook-handlers';
import { registerCiAutofixHandler } from './lib/ci-autofix/webhook-handler';
import { startCiAutofixOrchestrator } from './lib/ci-autofix/fix-orchestrator';
import ciAutofixRouter from './routes/ci-autofix';
import agentHooksRouter from './routes/agent-hooks';
import agentProfilesRouter from './routes/agent-profiles';
import notificationsRouter from './routes/notifications';
import settingsRouter from './routes/settings';
import billingRouter, { webhookRouter as billingWebhookRouter } from './routes/billing';
import { fireAgentHooks } from './lib/agent-hook-runner';
import { startNotificationDispatcher } from './lib/notification-dispatcher';
import { registerDraftPrSubscriber } from './lib/draft-pr-subscriber';
import { startQueueConsumer } from './lib/queue-consumer';
import { startMemorySynthesis } from './lib/memory-synthesis';
import { startFileWatcher } from './lib/file-watcher';
import { startEmbeddingPipeline } from './lib/embedding-pipeline';
import { startWalListener } from './lib/wal-listener';
import { subscribe, type WalEvent } from './lib/sse-hub';
import { rotateMemory } from './lib/memory-ledger';
import { deduplicateMemory } from './lib/memory-dedup';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './lib/swagger';
import { rateLimiter, initRateLimiterCache } from './lib/rate-limiter';
import { publicReviewRouter, specReviewRouter } from './routes/review';
import fileWatchRouter from './routes/file-watch';
import { errorHandler } from './lib/error-handler';
import { csrfProtection } from './lib/csrf';
import { queryTimerMiddleware, runQueryPlanAudit } from './lib/query-timer';
import { execute, queryOne } from './db/index';
import runQueueRouter from './routes/run-queue';
import configRouter from './routes/config';
import copilotRouter from './routes/copilot';
import memoryRouter from './routes/memory';
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
import { agentType } from './lib/config';
import { requireOpenCode } from './lib/opencode-detector';
import { buildMcpToolTierResolver, createMcpRequestHandler, getMcpToolDefinitions } from './lib/mcp-http';
import telemetryRouter from './routes/telemetry';
import authE2ERouter from './routes/auth-e2e';
import { logger } from './lib/logger';
import pinoHttp from 'pino-http';
import { startGraphPopulator } from './lib/graph-populator';
import workspaceDriftRouter from './routes/workspace-drift';
import graphRouter from './routes/graph';
import workflowRouterRouter from './routes/workflow-router';
import { startDriftSubscriber } from './lib/drift-subscriber';
import { startMarkerInjector } from './lib/marker-injector';
import { StoryLogFollower } from './lib/story-log-follower';
import { startCommitStatusPoster } from './lib/commit-status-poster';
import { startCheckRunPoster } from './lib/check-run-poster';
import attachmentsRouter from './routes/attachments';
import mcpToolsRouter from './routes/mcp-tools';
import terminalRouter, { validateWsToken } from './routes/terminal';
import { initBoss } from './lib/pg-boss';
import { WebSocketServer, WebSocket } from 'ws';
import * as ptyManager from './lib/pty-manager';
import http from 'http';
import { AuthError } from './lib/errors';
import {
  ensureMcpToken,
  isAllowedMcpOrigin,
  MCP_ALLOWED_ORIGINS,
  requireLocalhost,
  requireMcpAuth,
} from './lib/mcp-auth';
import { summarizeRorcaTiers } from './lib/tier-auth';
import { planGate } from './lib/plan-gate';

const OSC_TITLE_REGEX = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC_SEQUENCE_REGEX = /\x1b\][02];[^\x07\x1b]*(?:\x07|\x1b\\)/g;

function extractOscTitles(data: string): string[] {
  const titles: string[] = [];
  for (const match of data.matchAll(OSC_TITLE_REGEX)) {
    const title = match[1]?.trim();
    if (typeof title === 'string') {
      titles.push(title);
    }
  }
  return titles;
}

function hasBellOutsideOsc(data: string): boolean {
  if (!data.includes('\x07')) {
    return false;
  }

  const withoutOsc = data.replace(OSC_SEQUENCE_REGEX, '');
  return withoutOsc.includes('\x07');
}

// OC-002: Fail-fast if RORCA_AGENT=opencode but binary is missing
if (agentType === 'opencode') {
  requireOpenCode();
}

const app = express();
const PORT = process.env.PORT || 3030;
const BACKGROUND_RUNTIME_ENABLED =
  process.env.NODE_ENV !== 'test' &&
  process.env.RORCA_DISABLE_BACKGROUND_RUNTIME !== 'true';
const MCP_HTTP_ENABLED = process.env.RORCA_SERVE_MCP !== 'false';

// Disable ETags on API responses — prevents browsers from caching 404s and replaying
// stale error responses after backend state changes (workspace renames, schema fixes, etc.).
app.set('etag', false);
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// PR-008: Structured request/response logging — method, url, statusCode, responseTime
app.use(pinoHttp({ logger }));

// CORS configuration — explicit origin required; no wildcards in production.
// CORS_ORIGIN defaults to http://localhost:5210 for development.
// In production, set CORS_ORIGIN to https://rorca.app (or comma-separated list).
let corsOrigin: boolean | string | string[];
let allowCredentials = false;

// CLI-046: Only trust proxy headers for MCP when operators explicitly opt into
// remote MCP behind a trusted TLS terminator that sanitizes Authorization.
app.set('trust proxy', process.env.RORCA_MCP_ALLOW_REMOTE === 'true');

if (process.env.RORCA_SERVE_STATIC === '1') {
  // Same-origin static mode: reflect request origin (frontend served by Express)
  corsOrigin = true;
  allowCredentials = true;
} else {
  const rawOrigin = process.env.CORS_ORIGIN || '';

  if (!rawOrigin) {
    console.warn('WARNING: CORS_ORIGIN not set — defaulting to http://localhost:5210 (development only)');
  }

  if (process.env.NODE_ENV === 'production' && (!rawOrigin || rawOrigin === '*')) {
    console.warn('WARNING: CORS_ORIGIN not configured for production — set CORS_ORIGIN to restrict access');
  }

  // Default to localhost:5210 for development; never use wildcard '*'
  const effectiveOrigin = rawOrigin && rawOrigin !== '*' ? rawOrigin : 'http://localhost:5210';
  const origins = effectiveOrigin.split(',').map((o: string) => o.trim()).filter(Boolean);
  corsOrigin = origins.length === 1 ? origins[0] : origins;
  allowCredentials = true;
}

app.use(cors({
  origin: corsOrigin,
  credentials: allowCredentials,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Workspace-Id', 'X-Rorca-Admin-Key'],
  maxAge: 86400,
}));

// Capture raw body for webhook signature verification.
// The verify callback fires before JSON parsing, giving us the exact bytes GitHub sent.
app.use(express.json({
  verify: (req, _res, buf) => {
    const url = (req as express.Request).originalUrl || '';
    if (url.startsWith('/api/webhooks/') || url.startsWith('/api/billing/webhook')) {
      (req as any).rawBody = buf;
    }
  },
}));

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
app.use('/api/doctor', doctorRouter);
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
app.use('/api/webhooks', webhooksRouter);
app.use('/api/billing', billingWebhookRouter); // Stripe webhook (no auth, needs raw body)
app.use('/api/invites', rateLimiter, invitesRouter);
// EQ-007: Public review routes (no auth required — accessed via shareable token)
app.use('/api/review', rateLimiter, publicReviewRouter);
if (BACKGROUND_RUNTIME_ENABLED) {
  registerWebhookHandlers();
  registerCiAutofixHandler();
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

// ─── Auth middleware (all routes below require authentication) ───
// PR-009: Conditional auth — AUTH_REQUIRED=true enforces JWT on all protected routes.
// Default (false/absent) = local single-user mode: inject local admin so req.user is
// always defined (prevents crashes in routes that access user.id unconditionally).
if (process.env.AUTH_REQUIRED === 'true') {
  app.use(authRequired);
} else {
  // Local single-user mode: use JWT if provided and valid, otherwise inject local admin.
  // Stale/invalid tokens are ignored (not rejected) so local dev doesn't break when
  // the frontend has a leftover Supabase session from a previous run.
  app.use(async (req: any, _res: any, next: any) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (token) {
      try {
        const resolvedUser = await resolveAuthUserFromToken(token);
        if (resolvedUser) {
          req.user = resolvedUser;
          return next();
        }
        return next(new AuthError('Invalid token'));
      } catch {
        return next(new AuthError('Invalid token'));
      }
    }
    req.user = LOCAL_ADMIN;
    next();
  });
}

// ─── Rate limiting (after auth so req.user is available) ───
app.use(rateLimiter);

// ─── CSRF protection (double-submit cookie pattern) ───
// Validates X-CSRF-Token header against _csrf cookie on POST/PUT/PATCH/DELETE.
// Exempt: webhooks, MCP, docs, health, CSRF bootstrap, login/register, billing webhook.
app.use(csrfProtection);
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
app.use('/api/pipeline', pipelineRouter);
app.use('/api/pipeline/hooks', hooksRouter);
app.use('/api/pipeline/schedules', schedulesRouter);
app.use('/api/worktrees', worktreesRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/stories', storiesRouter);
app.use('/api/workspaces/:id/env-vars', envVarsRouter);
app.use('/api/workspaces/:id/budget', budgetRouter);
app.use('/api/workspaces/:id/agent-hooks', agentHooksRouter);
app.use('/api/workspaces/:id/agent-profiles', agentProfilesRouter);
app.use('/api/workspaces/:id/ci-autofix', ciAutofixRouter);
app.use('/api/workspaces/:id/github', workspaceGithubRouter);
app.use('/api/workspaces/:id/integrations', workspaceIntegrationsRouter);
app.use('/api/workspaces/:id/integrations', integrationAuditLogRouter);
app.use('/api/workspaces', workspaceDriftRouter);
app.use('/api/github/checks', githubChecksRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/activity', activityRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/vault/keys', vaultRouter);
app.use('/api/users', usersRouter);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/admin', backupsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/run-queue', runQueueRouter);
app.use('/api/config', configRouter);
app.use('/api/copilot', copilotRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/memory/cross-workspace', crossWorkspaceMemoryRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/workspaces', contextRoutingRouter);
app.use('/api/workspaces', contextFilesRouter);
app.use('/api/conventions', conventionsRouter);
app.use('/api/packs', packsRouter);
app.use('/api/skills', skillsRouter);
app.use('/api/attachments', attachmentsRouter);
app.use('/api/terminal', terminalRouter); // OCT-002: PTY session management
app.use('/api/personas', personasRouter);
app.use('/api/marketplace', marketplaceRouter);
app.use('/api/search', searchRouter);
app.use('/api/recall', recallRouter);
app.use('/api/graph', graphRouter);
app.use('/api/workflow-router', workflowRouterRouter);
app.use('/api/terminal', terminalRouter);

// V2-094: Centralized error handler (must be after all routes)
app.use(errorHandler);

const storyLogFollower = new StoryLogFollower();

if (BACKGROUND_RUNTIME_ENABLED) {
  // V2-069: Subscribe agent hook runner to all WAL broadcasts
  subscribe(fireAgentHooks);

  // V2-073: Subscribe notification dispatcher to WAL broadcasts
  startNotificationDispatcher();

  // US-034: Subscribe draft PR lifecycle to update PR body on story completions
  registerDraftPrSubscriber();

  // RQ-002: Subscribe queue consumer to auto-trigger next run on completion
  startQueueConsumer();

  // CIE-005: Subscribe memory synthesis to generate ledger entries after successful runs
  startMemorySynthesis();

  // PG-007: Subscribe embedding pipeline to WAL events for automatic vector generation
  startEmbeddingPipeline();

  // PG-015: Subscribe graph populator to WAL events for knowledge graph edges
  startGraphPopulator();

  // PG-017: Subscribe drift detector to WAL events for post-run convention drift analysis
  startDriftSubscriber();

  // US-008: Subscribe marker injector to write story completion markers into run_output_chunks
  startMarkerInjector();

  // US-004: Subscribe story-log-follower to tail story logs and write prose to story_output_chunks
  storyLogFollower.start();

  // US-027: Subscribe commit status poster to post GitHub status checks for story progress
  startCommitStatusPoster();

  // US-030: Subscribe check run poster to manage GitHub Check Runs for pipeline runs
  startCheckRunPoster();

  // CAF-002: Subscribe CI autofix orchestrator to generate fix specs on ci_check_failed events
  startCiAutofixOrchestrator();

  // PR-019: Auto-rotate memory after each pipeline run completion
  // PR-018: Auto-deduplicate memory after rotation (post-run)
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

// Safety net: log unhandled rejections instead of crashing the process.
// Routes should handle their own errors, but this prevents a single bad request
// from taking down the entire backend.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, '[UnhandledRejection] Caught — process kept alive');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, '[UncaughtException] Caught — process kept alive');
});

/* istanbul ignore next -- only when run directly, not in tests */
if (process.env.NODE_ENV !== 'test') {
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
      // Check for trial via DB
      const { queryOne: qo } = require('./db/index');
      (qo(
        `SELECT trial_ends_at, plan FROM subscriptions WHERE status = 'trialing' AND trial_ends_at > NOW() LIMIT 1`
      ) as Promise<{ trial_ends_at: string; plan: string } | undefined>).then((trial) => {
        if (trial) {
          const days = Math.max(0, Math.ceil((new Date(trial.trial_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
          logger.info(`License: trial (${days} days remaining)`);
        } else {
          logger.info('License: not configured');
        }
      }).catch(() => {
        logger.info('License: not configured');
      });
    }
  })();

  // OCT-021: Bind HTTP server to loopback by default in local mode.
  // This reduces exposure of the unauthenticated local API/WebSocket surface; cloud/Docker
  // deployments can opt in to broader exposure with RORCA_BIND_HOST=0.0.0.0.
  const bindHost = process.env.RORCA_BIND_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  const listenPort = Number(PORT);
  const httpServer = app.listen(listenPort, bindHost, () => {
    logger.info(`Rorca backend listening on ${bindHost}:${PORT}`);
    execute(
      `UPDATE terminal_sessions
       SET status = 'killed', exited_at = NOW()
       WHERE status = 'active'`
    ).catch(err => logger.error({ err }, '[terminal] Startup cleanup failed'));
    initRateLimiterCache().catch(err => logger.error({ err }, '[RateLimiter] Cache init failed'));
    runQueryPlanAudit().catch(err => logger.error({ err }, '[QueryAudit] Startup audit failed'));
    queryOne('SELECT id FROM workspaces LIMIT 1').then(row => {
      if (!row) logger.warn('[StartupCheck] No workspaces found — onboarding will show');
      else logger.info({ id: (row as any).id }, '[StartupCheck] Workspace query OK — search_path verified');
    }).catch(err => logger.error({ err }, '[StartupCheck] Workspace query FAILED — search_path may be wrong'));

    if (!BACKGROUND_RUNTIME_ENABLED) {
      logger.info('[server] Background runtime disabled for this process');
      return;
    }

    // OC-015: Clean up orphan runs (stale status='running' from crashed backend)
    cleanupOrphanRuns();
    // Scheduler runs in-process with API — see CLI-035 Supervisor decision.
    startScheduler();
    cleanupOldLogs();
    // CIE-009: Start file watchers for all registered workspaces
    startFileWatcher();
    // PG-004: Initialise pg-boss so the Express process can send jobs
    initBoss().catch(err => logger.error({ err }, '[pg-boss] startup init failed'));
    // US-004: Recover in-flight stories from before server restart
    storyLogFollower.recover().catch(err => logger.error({ err }, '[story-log-follower] Recovery failed'));
    // US-003: Start dedicated LISTEN/NOTIFY client for real-time WAL event push
    startWalListener();
  });

  // OCT-002/OCT-021: WebSocket server for PTY I/O with origin validation and connection tokens
  // Security model (OCT-021):
  // 1. Origin validation — rejects cross-origin connections (DNS rebinding defense)
  // 2. Short-lived wsToken (60s TTL) — prevents sessionId enumeration
  // 3. Secure binding (127.0.0.1 by default) — local-only unless RORCA_BIND_HOST=0.0.0.0
  // 4. Security headers — X-Content-Type-Options: nosniff, X-Frame-Options: DENY
  const ALLOWED_WS_ORIGINS = [
    'http://localhost:5210',
    'http://127.0.0.1:5210',
    'http://localhost:3030',
    'http://127.0.0.1:3030',
  ];

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/terminal',
    // OCT-021: Verify client origin to prevent cross-origin WebSocket attacks (DNS rebinding)
    verifyClient: ({ origin, req }, done) => {
      // Allow connections from allowed origins or when origin header is absent (local tools)
      if (!origin || ALLOWED_WS_ORIGINS.includes(origin)) {
        done(true);
      } else {
        logger.warn({ origin }, '[ws] Rejected WebSocket connection from disallowed origin');
        done(false, 403, 'Forbidden');
      }
    },
  });

  httpServer.on('headers', (headers, req) => {
    if (req.url?.startsWith('/ws/terminal')) {
      headers.push('X-Content-Type-Options: nosniff');
    }
  });

  wss.on('connection', async (ws: WebSocket, req: http.IncomingMessage) => {
    // OCT-021: Extract and validate wsToken (short-lived connection token)
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const wsToken = url.searchParams.get('wsToken');

    if (!wsToken) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing wsToken parameter' }));
      ws.close();
      return;
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    let wsUserId: string | undefined;
    if (token && process.env.SUPABASE_URL?.trim()) {
      try {
        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (!error && data.user?.id) {
          wsUserId = data.user.id;
        }
      } catch {
      }
    }

    const sessionId = validateWsToken(wsToken, wsUserId);
    if (!sessionId) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired wsToken' }));
      ws.close();
      return;
    }

    // Look up the session
    const session = ptyManager.getSession(sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      ws.close();
      return;
    }

    logger.info(`[ws] Client connected to session ${sessionId}`);
    ptyManager.attachSocket(sessionId, ws);

    // Subscribe to PTY output
    const dataListener = session.ptyProcess.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const titles = extractOscTitles(data);
          const shouldEmitBell = hasBellOutsideOsc(data);
          const { cleanData, shellEvents } = ptyManager.processSessionOutput(sessionId, data);
          session.nextSequence += 1;
          ws.send(JSON.stringify({ type: 'output', data: cleanData, sequence: session.nextSequence }));
          for (const title of titles) {
            ws.send(JSON.stringify({ type: 'title_change', title }));
          }
          if (shouldEmitBell) {
            ws.send(JSON.stringify({ type: 'bell' }));
          }
          for (const shellEvent of shellEvents) {
            ws.send(JSON.stringify(shellEvent));
          }
        } catch (err) {
          logger.error({ err, sessionId }, '[ws] Failed to send PTY output to client');
        }
      }
    });

    // Subscribe to PTY exit
    const exitListener = session.ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'exit', exitCode }));
          ws.close();
        } catch (err) {
          logger.error({ err, sessionId }, '[ws] Failed to send exit message to client');
        }
      }
    });

    // Handle incoming messages from client
    ws.on('message', (rawMessage: Buffer | string) => {
      try {
        if (ptyManager.isInputTooLarge(rawMessage)) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Input too large' }));
          }
          return;
        }

        const message = JSON.parse(rawMessage.toString());

        switch (message.type) {
          case 'input':
            if (typeof message.data === 'string') {
              session.ptyProcess.write(message.data);
            }
            break;

          case 'resize':
            if (typeof message.rows === 'number' && typeof message.cols === 'number') {
              ptyManager.resizeSession(sessionId, message.rows, message.cols);
            }
            break;

          case 'ping':
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
            break;

          default:
            logger.warn({ type: message.type, sessionId }, '[ws] Unknown message type');
        }
      } catch (err) {
        logger.warn({ err, sessionId }, '[ws] Failed to parse incoming message — ignoring');
      }
    });

    // Handle WebSocket errors
    ws.on('error', (err) => {
      logger.error({ err, sessionId }, '[ws] WebSocket error');
      dataListener.dispose();
      exitListener.dispose();
      ptyManager.detachSocket(sessionId, ws);
    });

    // Handle WebSocket close
    ws.on('close', () => {
      logger.info(`[ws] Client disconnected from session ${sessionId}`);
      dataListener.dispose();
      exitListener.dispose();
      ptyManager.detachSocket(sessionId, ws);
    });
  });

  logger.info('[ws] WebSocket server mounted at /ws/terminal');

  let shuttingDown = false;
  const shutdown = async (signal: 'SIGTERM' | 'SIGINT') => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, '[server] Graceful shutdown started');

    try {
      await ptyManager.shutdownAll();
    } catch (err) {
      logger.error({ err, signal }, '[server] PTY shutdown failed during graceful shutdown');
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
