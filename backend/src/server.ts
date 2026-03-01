import express from 'express';
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
import webhooksRouter from './routes/webhooks';
import githubChecksRouter from './routes/github-checks';
import teamsRouter from './routes/teams';
import invitesRouter from './routes/invites';
import activityRouter from './routes/activity';
import analyticsRouter from './routes/analytics';
import budgetRouter from './routes/budget';
import vaultRouter from './routes/vault';
import usersRouter from './routes/users';
import authRouter, { authRequired } from './routes/auth';
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
import { startQueueConsumer } from './lib/queue-consumer';
import { startMemorySynthesis } from './lib/memory-synthesis';
import { startFileWatcher } from './lib/file-watcher';
import { subscribe } from './lib/sse-hub';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './lib/swagger';
import { rateLimiter } from './lib/rate-limiter';
import { publicReviewRouter, specReviewRouter } from './routes/review';
import fileWatchRouter from './routes/file-watch';
import { errorHandler } from './lib/error-handler';
import { queryTimerMiddleware, runQueryPlanAudit } from './lib/query-timer';
import { db } from './db/index';
import runQueueRouter from './routes/run-queue';
import configRouter from './routes/config';
import copilotRouter from './routes/copilot';
import memoryRouter from './routes/memory';
import agentsRouter from './routes/agents';
import contextRoutingRouter from './routes/context-routing';
import contextFilesRouter from './routes/context-files';
import conventionsRouter from './routes/conventions';
import packsRouter from './routes/packs';
import skillsRouter from './routes/skills';
import { agentType } from './lib/config';
import { requireOpenCode } from './lib/opencode-detector';

dotenv.config();

// OC-002: Fail-fast if RORCA_AGENT=opencode but binary is missing
if (agentType === 'opencode') {
  requireOpenCode();
}

const app = express();
const PORT = process.env.PORT || 3030;

// When serving static frontend (rorca start), allow same-origin; otherwise allow Vite dev server
const corsOrigin = process.env.RORCA_SERVE_STATIC === '1'
  ? true  // reflect request origin (same-origin when served by Express)
  : (process.env.CORS_ORIGIN || 'http://localhost:5210');
app.use(cors({ origin: corsOrigin }));

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

// ─── Auth middleware (all routes below require authentication) ───
// Auth gate bypassed — Rorca is a local single-user tool (see CLAUDE.md)
// app.use(authRequired);

// ─── Rate limiting (after auth so req.user is available) ───
app.use(rateLimiter);

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
app.use('/api/agents', agentsRouter);
app.use('/api/workspaces', contextRoutingRouter);
app.use('/api/workspaces', contextFilesRouter);
app.use('/api/conventions', conventionsRouter);
app.use('/api/packs', packsRouter);
app.use('/api/skills', skillsRouter);

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

// RQ-002: Subscribe queue consumer to auto-trigger next run on completion
startQueueConsumer();

// CIE-005: Subscribe memory synthesis to generate ledger entries after successful runs
startMemorySynthesis();

/* istanbul ignore next -- only when run directly, not in tests */
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Rorca backend listening on port ${PORT}`);
    // OC-015: Clean up orphan runs (stale status='running' from crashed backend)
    cleanupOrphanRuns();
    startScheduler();
    cleanupOldLogs();
    // V2-099: Run EXPLAIN QUERY PLAN audit at startup
    runQueryPlanAudit(db);
    // CIE-009: Start file watchers for all registered workspaces
    startFileWatcher();
  });
}

export default app;
