import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import workspacesRouter from './routes/workspaces';
import directionRouter from './routes/direction';
import specsRouter from './routes/specs';
import walRouter from './routes/wal';
import contextRouter from './routes/context';
import pipelineRouter from './routes/pipeline';
import worktreesRouter from './routes/worktrees';
import templatesRouter from './routes/templates';
import storiesRouter from './routes/stories';
import authRouter, { authRequired } from './routes/auth';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3030;

app.use(cors({ origin: 'http://localhost:5210' }));
app.use(express.json());

// ─── Public routes (no auth required) ───
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use('/api/auth', authRouter);

// ─── Auth middleware (all routes below require authentication) ───
app.use(authRequired);

// ─── Protected routes ───
app.use('/api/workspaces', workspacesRouter);
app.use('/api/direction', directionRouter);
app.use('/api/specs', specsRouter);
app.use('/api/wal', walRouter);
app.use('/api/context', contextRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/worktrees', worktreesRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/stories', storiesRouter);

/* istanbul ignore next -- only when run directly, not in tests */
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Rorcha backend listening on port ${PORT}`);
  });
}

export default app;
