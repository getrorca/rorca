import { createHash } from 'node:crypto';
import { execute, query } from '../db/index';
import type { McpTier } from './mcp-auth';
import { logger } from './logger';

export interface McpAuditEntry {
  toolName: string;
  tokenTier: McpTier;
  remoteAddr?: string | null;
  sessionId?: string | null;
  paramsHash?: string | null;
  params?: unknown;
  success: boolean;
  errorCode?: string | null;
  durationMs?: number | null;
}

export interface McpRateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  limit?: number;
  remaining?: number;
}

interface WindowEntry {
  timestamps: number[];
}

const SENSITIVE_KEY_PATTERN = /password|token|key|secret|apiKey/i;
const MCP_AUDIT_WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const rateLimitWindows = new Map<string, WindowEntry>();

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - MCP_AUDIT_WINDOW_MS;
    for (const [key, entry] of rateLimitWindows.entries()) {
      entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);
      if (entry.timestamps.length === 0) {
        rateLimitWindows.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

startCleanup();

function canonicalize(value: unknown, parentKey?: string): unknown {
  if (parentKey && SENSITIVE_KEY_PATTERN.test(parentKey)) {
    return '[REDACTED]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key], key);
  }
  return out;
}

function getEnvLimit(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function getDefaultRateLimit(tokenTier: McpTier): number {
  return tokenTier === 'admin'
    ? getEnvLimit('RORCA_MCP_ADMIN_RATE_LIMIT', 300)
    : getEnvLimit('RORCA_MCP_PUBLIC_RATE_LIMIT', 100);
}

function getToolOverride(toolName: string): number | null {
  if (toolName === 'rorca_pipeline_trigger') return 10;
  if (toolName === 'rorca_specs_generate') return 5;
  if (toolName === 'rorca_search') return 60;
  return null;
}

function maybeLogFullParams(toolName: string, params: unknown): void {
  if (process.env.RORCA_MCP_AUDIT_FULL_PARAMS !== '1') return;
  logger.info({ toolName, params }, '[MCP Audit] Full params enabled');
}

export function paramsHash(params: unknown): string {
  const canonical = canonicalize(params);
  const serialized = JSON.stringify(canonical);
  return createHash('sha256').update(serialized).digest('hex');
}

export function extractErrorCode(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.code === 'string') return record.code;
    if (record.error && typeof record.error === 'object' && typeof (record.error as Record<string, unknown>).code === 'string') {
      return String((record.error as Record<string, unknown>).code);
    }
  }
  if (typeof body === 'string') {
    const codeMatch = body.match(/"code"\s*:\s*"([^"]+)"/);
    if (codeMatch) return codeMatch[1];
  }
  return null;
}

export function consumeMcpRateLimit(toolName: string, tokenTier: McpTier): McpRateLimitResult {
  if (process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_ENABLED !== 'true') {
    return { allowed: true };
  }

  const limit = getToolOverride(toolName) ?? getDefaultRateLimit(tokenTier);
  const key = `${tokenTier}:${toolName}`;
  const now = Date.now();
  const cutoff = now - MCP_AUDIT_WINDOW_MS;
  let entry = rateLimitWindows.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitWindows.set(key, entry);
  }

  entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);

  if (entry.timestamps.length >= limit) {
    const oldest = entry.timestamps[0] ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + MCP_AUDIT_WINDOW_MS - now) / 1000));
    return {
      allowed: false,
      retryAfterSeconds,
      limit,
      remaining: 0,
    };
  }

  entry.timestamps.push(now);
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - entry.timestamps.length),
  };
}

export async function recordMcpCall(entry: McpAuditEntry): Promise<void> {
  if (entry.params !== undefined) {
    maybeLogFullParams(entry.toolName, entry.params);
  }

  await execute(
    `INSERT INTO mcp_audit_log (
      tool_name,
      token_tier,
      remote_addr,
      session_id,
      params_hash,
      success,
      error_code,
      duration_ms
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.toolName,
      entry.tokenTier,
      entry.remoteAddr ?? null,
      entry.sessionId ?? null,
      entry.paramsHash ?? null,
      entry.success,
      entry.errorCode ?? null,
      entry.durationMs ?? null,
    ],
  );
}

export async function runMcpAuditAnomalyScan(): Promise<void> {
  try {
    const highVolume = await query<{ tool_name: string; call_count: string }>(
      `SELECT tool_name, COUNT(*)::text AS call_count
       FROM mcp_audit_log
       WHERE ts >= NOW() - INTERVAL '1 hour'
       GROUP BY tool_name
       HAVING COUNT(*) > 1000
       ORDER BY COUNT(*) DESC`,
    );

    for (const row of highVolume) {
      logger.warn({ toolName: row.tool_name, callCount: Number(row.call_count) }, '[MCP Audit] High-volume tool anomaly detected');
    }

    const highErrorRate = await query<{ tool_name: string; total_count: string; error_count: string; error_rate: string }>(
      `SELECT
         tool_name,
         COUNT(*)::text AS total_count,
         COUNT(*) FILTER (WHERE success = false)::text AS error_count,
         ROUND((COUNT(*) FILTER (WHERE success = false))::numeric / NULLIF(COUNT(*), 0), 4)::text AS error_rate
       FROM mcp_audit_log
       WHERE ts >= NOW() - INTERVAL '1 hour'
       GROUP BY tool_name
       HAVING COUNT(*) > 0
          AND (COUNT(*) FILTER (WHERE success = false))::numeric / NULLIF(COUNT(*), 0) > 0.5
       ORDER BY (COUNT(*) FILTER (WHERE success = false)) DESC`,
    );

    for (const row of highErrorRate) {
      logger.warn(
        {
          toolName: row.tool_name,
          totalCount: Number(row.total_count),
          errorCount: Number(row.error_count),
          errorRate: Number(row.error_rate),
        },
        '[MCP Audit] High error-rate tool anomaly detected',
      );
    }

    const authStorms = await query<{ remote_addr: string; failure_count: string }>(
      `SELECT remote_addr, COUNT(*)::text AS failure_count
       FROM mcp_audit_log
       WHERE ts >= NOW() - INTERVAL '5 minutes'
         AND remote_addr IS NOT NULL
         AND error_code IN ('MCP_AUTH_REQUIRED', 'MCP_AUTH_INVALID', 'MCP_AUTH_INSUFFICIENT_TIER')
       GROUP BY remote_addr
       HAVING COUNT(*) > 50
       ORDER BY COUNT(*) DESC`,
    );

    for (const row of authStorms) {
      logger.warn(
        { remoteAddr: row.remote_addr, failureCount: Number(row.failure_count) },
        '[MCP Audit] Auth failure storm detected',
      );
    }
  } catch (err) {
    logger.warn({ err }, '[MCP Audit] Anomaly scan failed');
  }
}

export function getMcpAuditRetentionDays(): number {
  return getEnvLimit('RORCA_MCP_AUDIT_RETENTION_DAYS', 90);
}

export async function pruneExpiredMcpAuditLogs(): Promise<number> {
  try {
    const retentionDays = getMcpAuditRetentionDays();
    const result = await execute(
      `DELETE FROM mcp_audit_log
       WHERE ts < NOW() - ($1 * INTERVAL '1 day')`,
      [retentionDays],
    );
    if (result.rowCount > 0) {
      logger.info({ deletedRows: result.rowCount, retentionDays }, '[MCP Audit] Pruned expired audit rows');
    }
    return result.rowCount;
  } catch (err) {
    logger.warn({ err }, '[MCP Audit] Retention prune failed');
    return 0;
  }
}

export function resetMcpAuditRateLimitWindows(): void {
  rateLimitWindows.clear();
}

export function stopMcpAuditCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
