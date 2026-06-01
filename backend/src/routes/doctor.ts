/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router } from 'express';
import { execSync } from 'child_process';
import { dbHealthCheck, queryOne } from '../db/index';
import { activeAgent } from '../lib/config';
import { detectPi, listPiModels } from '../lib/pi-detector';
import { getMcpTokenPath } from '../lib/mcp-auth';
import fs from 'node:fs';

const router = Router();

type DoctorCheckStatus = 'ok' | 'warning' | 'error';

interface DoctorCheck {
  id:
    | 'docker'
    | 'database-container'
    | 'backend'
    | 'database'
    | 'worker'
    | 'mcp-token'
    | 'pi-installed'
    | 'pi-authenticated'
    | 'workspace'
    | 'agent';
  label: string;
  status: DoctorCheckStatus;
  message: string;
  fix?: string;
  details?: Record<string, unknown>;
}

interface DoctorResponse {
  status: 'ok' | 'error';
  summary: {
    errors: number;
    warnings: number;
    ok: number;
    message: string;
  };
  agentType: string;
  generatedAt: string;
  checks: DoctorCheck[];
}

function isDockerInstalled(): boolean {
  try {
    execSync(process.platform === 'win32' ? 'where docker' : 'which docker', {
      stdio: 'pipe',
      timeout: 3000,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

function runShellCommand(command: string, timeout = 3000): string {
  const shellCommand = process.platform === 'win32'
    ? `cmd /d /s /c "${command}"`
    : `sh -lc '${command.replace(/'/g, `'\\''`)}'`;

  return execSync(shellCommand, {
    stdio: 'pipe',
    timeout,
    encoding: 'utf8',
  }).trim();
}

function summarize(checks: DoctorCheck[]): DoctorResponse['summary'] {
  const errors = checks.filter((check) => check.status === 'error').length;
  const warnings = checks.filter((check) => check.status === 'warning').length;
  const ok = checks.filter((check) => check.status === 'ok').length;

  return {
    errors,
    warnings,
    ok,
    message: errors === 0 ? 'All checks passed' : `${errors} issue(s) found`,
  };
}

/**
 * @swagger
 * /api/doctor:
 *   get:
 *     tags: [Health]
 *     summary: Comprehensive system health check
 *     operationId: getDoctor
 *     description: Runs the CLI doctor checks on the server side and returns ordered, actionable results for Docker, database container, backend dependencies, worker, Pi CLI, workspace registration, and active agent configuration.
 *     responses:
 *       200:
 *         description: Doctor results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [ok, error]
 *                 agentType:
 *                   type: string
 *                 generatedAt:
 *                   type: string
 *                 summary:
 *                   type: object
 *                   properties:
 *                     errors: { type: integer }
 *                     warnings: { type: integer }
 *                     ok: { type: integer }
 *                     message: { type: string }
 *                 checks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       label: { type: string }
 *                       status: { type: string, enum: [ok, warning, error] }
 *                       message: { type: string }
 *                       fix: { type: string, nullable: true }
 */
router.get('/', async (_req, res, next) => {
  try {
    const checks: DoctorCheck[] = [];

    const dockerInstalled = isDockerInstalled();
    if (!dockerInstalled) {
      checks.push({
        id: 'docker',
        label: 'Docker running',
        status: 'error',
        message: 'Docker not found',
        fix: 'Install from https://docs.docker.com/get-docker/',
      });
      checks.push({
        id: 'database-container',
        label: 'Database container running',
        status: 'error',
        message: 'Database container not running',
        fix: 'Run: rorca db start',
      });
    } else {
      try {
        runShellCommand('docker info 2>/dev/null', 3000);
        checks.push({
          id: 'docker',
          label: 'Docker running',
          status: 'ok',
          message: 'Docker is running',
        });
      } catch {
        checks.push({
          id: 'docker',
          label: 'Docker running',
          status: 'error',
          message: 'Docker not running',
          fix: 'Start Docker Desktop (or OrbStack on macOS)',
        });
      }

      try {
        const status = runShellCommand(`docker ps --filter name=rorca-db --format '{{.Status}}'`, 3000);
        if (status) {
          checks.push({
            id: 'database-container',
            label: 'Database container running',
            status: 'ok',
            message: `Database container is up (${status})`,
          });
        } else {
          checks.push({
            id: 'database-container',
            label: 'Database container running',
            status: 'error',
            message: 'Database container not running',
            fix: 'Run: rorca db start',
          });
        }
      } catch {
        checks.push({
          id: 'database-container',
          label: 'Database container running',
          status: 'error',
          message: 'Database container not running',
          fix: 'Run: rorca db start',
        });
      }
    }

    checks.push({
      id: 'backend',
      label: 'Backend reachable',
      status: 'ok',
      message: 'Backend is running at http://localhost:3030',
    });

    try {
      const dbResult = await dbHealthCheck();
      checks.push({
        id: 'database',
        label: 'Database connected',
        status: dbResult.ok ? 'ok' : 'error',
        message: dbResult.ok ? 'Database connection is healthy' : 'Database not connected',
        ...(dbResult.ok ? {} : { fix: 'Check DATABASE_URL' }),
        details: { latencyMs: dbResult.latencyMs },
      });
    } catch {
      checks.push({
        id: 'database',
        label: 'Database connected',
        status: 'error',
        message: 'Database not connected',
        fix: 'Check DATABASE_URL',
      });
    }

    try {
      const tokenPath = getMcpTokenPath();
      if (!fs.existsSync(tokenPath)) {
        checks.push({
          id: 'mcp-token',
          label: 'MCP token',
          status: 'error',
          message: 'MCP token file is missing',
          fix: 'Restart Rorca or run: rorca mcp token',
        });
      } else if (process.platform !== 'win32' && (fs.statSync(tokenPath).mode & 0o777) !== 0o600) {
        const mode = (fs.statSync(tokenPath).mode & 0o777).toString(8);
        checks.push({
          id: 'mcp-token',
          label: 'MCP token',
          status: 'warning',
          message: `MCP token file mode is ${mode}, expected 600`,
          fix: 'Run: chmod 600 ~/.rorca/mcp-token',
        });
      } else {
        checks.push({
          id: 'mcp-token',
          label: 'MCP token',
          status: 'ok',
          message: 'MCP token file exists with secure mode 0600',
        });
      }
    } catch {
      checks.push({
        id: 'mcp-token',
        label: 'MCP token',
        status: 'warning',
        message: 'Unable to verify MCP token file mode',
        fix: 'Check ~/.rorca/mcp-token permissions',
      });
    }

    try {
      const worker = await queryOne<{ pid: number | null; last_seen: string }>(
        `SELECT pid, last_seen FROM worker_heartbeat ORDER BY last_seen DESC LIMIT 1`
      );

      if (!worker) {
        checks.push({
          id: 'worker',
          label: 'Worker running',
          status: 'error',
          message: 'Worker not running',
          fix: 'Start with: cd backend && npm run worker',
        });
      } else {
        const lastSeenMs = new Date(worker.last_seen).getTime();
        const ageSeconds = (Date.now() - lastSeenMs) / 1000;
        if (ageSeconds > 90) {
          checks.push({
            id: 'worker',
            label: 'Worker running',
            status: 'error',
            message: `Worker heartbeat is stale (${Math.round(ageSeconds)}s ago)`,
            fix: 'Start with: cd backend && npm run worker',
          });
        } else {
          checks.push({
            id: 'worker',
            label: 'Worker running',
            status: 'ok',
            message: `Worker heartbeat is fresh (pid ${worker.pid ?? 'unknown'})`,
          });
        }
      }
    } catch {
      checks.push({
        id: 'worker',
        label: 'Worker running',
        status: 'error',
        message: 'Worker not running',
        fix: 'Start with: cd backend && npm run worker',
      });
    }

    const pi = detectPi();
    if (!pi.piInstalled || !pi.piBinPath) {
      checks.push({
        id: 'pi-installed',
        label: 'Pi installed',
        status: 'error',
        message: 'Pi not found',
        fix: 'Install: npm install -g @mariozechner/pi-coding-agent (or pnpm add -g / bun add -g)',
      });
      checks.push({
        id: 'pi-authenticated',
        label: 'Pi authenticated',
        status: 'warning',
        message: 'Pi authentication not checked because Pi is not installed',
      });
    } else {
      checks.push({
        id: 'pi-installed',
        label: 'Pi installed',
        status: 'ok',
        message: `Pi is installed${pi.piVersion ? ` (${pi.piVersion})` : ''}`,
      });

      const models = listPiModels(pi.piBinPath);
      checks.push({
        id: 'pi-authenticated',
        label: 'Pi authenticated',
        status: models.length > 0 ? 'ok' : 'warning',
        message: models.length > 0
          ? `${models.length} Pi model(s) available`
          : 'Pi installed but no providers authenticated',
        ...(models.length > 0 ? {} : { fix: 'Run: pi auth login' }),
      });
    }

    try {
      const workspaceCountRow = await queryOne<{ cnt: string }>('SELECT COUNT(*)::int AS cnt FROM workspaces');
      const workspaceCount = parseInt(workspaceCountRow?.cnt ?? '0', 10);
      checks.push({
        id: 'workspace',
        label: 'At least one workspace',
        status: workspaceCount > 0 ? 'ok' : 'warning',
        message: workspaceCount > 0
          ? `${workspaceCount} workspace(s) registered`
          : 'No workspaces registered',
        ...(workspaceCount > 0 ? {} : { fix: 'Run: rorca init' }),
      });
    } catch {
      checks.push({
        id: 'workspace',
        label: 'At least one workspace',
        status: 'warning',
        message: 'No workspaces registered',
        fix: 'Run: rorca init',
      });
    }

    checks.push({
      id: 'agent',
      label: 'Active agent configured',
      status: activeAgent ? 'ok' : 'warning',
      message: activeAgent ? `Current agent: ${activeAgent}` : 'No active agent configured',
    });

    const summary = summarize(checks);
    const response: DoctorResponse = {
      status: summary.errors === 0 ? 'ok' : 'error',
      summary,
      agentType: activeAgent,
      generatedAt: new Date().toISOString(),
      checks,
    };

    res.json(response);
  } catch (err) {
    next(err);
  }
});

export default router;
