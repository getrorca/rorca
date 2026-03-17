// Patch Express 4 to catch async route handler rejections — must be first import
import './lib/async-handler';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import workspacesRouter from './routes/workspaces';
import directionRouter from './routes/direction';
import specsRouter from './routes/specs';
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
import authRouter, { authRequired, LOCAL_ADMIN } from './routes/auth';
import onboardingRouter from './routes/onboarding';
import backupsRouter from './routes/backups';
import healthRouter from './routes/health';
import { startScheduler } from './lib/scheduler';
import { registerWebhookHandlers } from './routes/webhook-handlers';
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
import { queryOne } from './db/index';
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
import { createMcpRequestHandler } from './lib/mcp-http';
import telemetryRouter from './routes/telemetry';
import { logger } from './lib/logger';
import pinoHttp from 'pino-http';
import { startGraphPopulator } from './lib/graph-populator';
import workspaceDriftRouter from './routes/workspace-drift';
import { startDriftSubscriber } from './lib/drift-subscriber';
import { startMarkerInjector } from './lib/marker-injector';
import { startCommitStatusPoster } from './lib/commit-status-poster';
import { startCheckRunPoster } from './lib/check-run-poster';
import attachmentsRouter from './routes/attachments';
import mcpToolsRouter from './routes/mcp-tools';
import { initBoss } from './lib/pg-boss';

dotenv.config();

// OC-002: Fail-fast if RORCA_AGENT=opencode but binary is missing
if (agentType === 'opencode') {
  requireOpenCode();
}

const app = express();
const PORT = process.env.PORT || 3030;

// Disable ETags on API responses — prevents browsers from caching 404s and replaying
// stale error responses after backend state changes (workspace renames, schema fixes, etc.).
app.set('etag', false);
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// PR-008: Structured request/response logging — method, url, statusCode, responseTime
app.use(pinoHttp({ logger }));

// PR-006: HTTP security headers via helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // required for Tailwind inline styles
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],   // allow SSE and WebSocket connections
    },
  },
  frameguard: { action: 'deny' },               // X-Frame-Options: DENY
  noSniff: true,                                 // X-Content-Type-Options: nosniff
  hsts: { maxAge: 31536000 },                   // Strict-Transport-Security
  xssFilter: false,                              // X-XSS-Protection: 0 (CSP is the real protection)
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permittedCrossDomainPolicies: false,
}));
// Permissions-Policy: restrict camera, microphone, geolocation
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// CORS configuration — explicit origin required; no wildcards in production.
// CORS_ORIGIN defaults to http://localhost:5210 for development.
// In production, set CORS_ORIGIN to https://rorca.app (or comma-separated list).
let corsOrigin: boolean | string | string[];
let allowCredentials = false;

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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Workspace-Id'],
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

// V2-099: Query timing middleware — logs requests taking >100ms
app.use(queryTimerMiddleware);

// ─── Public routes (no auth required) ───
app.use('/api/health', healthRouter);
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
registerWebhookHandlers();

// CA-021: MCP Streamable HTTP transport — auto-generated from OpenAPI spec
const mcpHandlers = createMcpRequestHandler(swaggerSpec as any);
app.post('/mcp', mcpHandlers.handlePost);
app.get('/mcp', mcpHandlers.handleGet);
app.delete('/mcp', mcpHandlers.handleDelete);

// MC-004: MCP Tools enumeration endpoint (public — used by VS Code extension, no auth required)
app.use('/api/mcp/tools', mcpToolsRouter);

// ─── Auth middleware (all routes below require authentication) ───
// PR-009: Conditional auth — AUTH_REQUIRED=true enforces JWT on all protected routes.
// Default (false/absent) = local single-user mode: inject local admin so req.user is
// always defined (prevents crashes in routes that access user.id unconditionally).
if (process.env.AUTH_REQUIRED === 'true') {
  app.use(authRequired);
} else {
  // Local single-user mode: use JWT if provided, otherwise inject local admin.
  // This allows tests that create real users and generate JWTs to work correctly.
  app.use(async (req: any, _res: any, next: any) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const { JWT_SECRET: secret } = require('./routes/auth');
        const decoded = jwt.verify(token, secret) as { sub: string; email: string };
        const { queryOne: qo } = require('./db/index');
        const user = await qo('SELECT id, email, role FROM users WHERE id = $1', [decoded.sub]);
        if (user) {
          req.user = { id: user.id, email: user.email, role: user.role };
          return next();
        }
      } catch {
        // Invalid JWT — fall through to local admin
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
// Exempt: webhooks, health, login, register, GitHub OAuth, billing webhook.
// Skips validation when _csrf cookie is absent (user not logged in).
app.use(csrfProtection);

// ─── Protected routes ───
app.use('/api/workspaces', workspacesRouter);
app.use('/api/workspace', fileWatchRouter);
app.use('/api/direction', directionRouter);
app.use('/api/specs', specsRouter);
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
app.use('/api/personas', personasRouter);
app.use('/api/marketplace', marketplaceRouter);
app.use('/api/search', searchRouter);
app.use('/api/recall', recallRouter);

// V2-108: Serve frontend static files when running via `rorca start`
if (process.env.RORCA_SERVE_STATIC === '1' && process.env.RORCA_STATIC_DIR) {
  const staticDir = process.env.RORCA_STATIC_DIR;
  app.use(express.static(staticDir));
  // SPA fallback: serve index.html for non-API routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

// V2-094: Centralized error handler (must be after all routes)
app.use(errorHandler);

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

// US-027: Subscribe commit status poster to post GitHub status checks for story progress
startCommitStatusPoster();

// US-030: Subscribe check run poster to manage GitHub Check Runs for pipeline runs
startCheckRunPoster();

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
  app.listen(PORT, () => {
    logger.info(`Rorca backend listening on port ${PORT}`);
    // OC-015: Clean up orphan runs (stale status='running' from crashed backend)
    cleanupOrphanRuns();
    startScheduler();
    cleanupOldLogs();
    // PR-xxx: Init rate limiter cache so fallback user ID is loaded (prevents 429s in single-user mode)
    initRateLimiterCache().catch(err => logger.error({ err }, '[RateLimiter] Cache init failed'));
    // V2-099: Run EXPLAIN QUERY PLAN audit at startup
    runQueryPlanAudit().catch(err => logger.error({ err }, '[QueryAudit] Startup audit failed'));
    // CIE-009: Start file watchers for all registered workspaces
    startFileWatcher();
    // PG-004: Initialise pg-boss so the Express process can send jobs
    initBoss().catch(err => logger.error({ err }, '[pg-boss] startup init failed'));
    // Startup self-test: verify workspace queries resolve against rorca schema (not ag_catalog)
    queryOne('SELECT id FROM workspaces LIMIT 1').then(row => {
      if (!row) logger.warn('[StartupCheck] No workspaces found — onboarding will show');
      else logger.info({ id: (row as any).id }, '[StartupCheck] Workspace query OK — search_path verified');
    }).catch(err => logger.error({ err }, '[StartupCheck] Workspace query FAILED — search_path may be wrong'));
  });
}

export default app;
