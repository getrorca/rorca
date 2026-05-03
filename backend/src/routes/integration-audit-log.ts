import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db/index';
import { NotFoundError } from '../lib/errors';
import { parsePaginationParams, paginateQuery } from '../lib/paginate';
import { logger } from '../lib/logger';

const router = Router({ mergeParams: true });

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditAction =
  | 'token_created'
  | 'token_revoked'
  | 'token_refreshed'
  | 'webhook_received'
  | 'webhook_processed'
  | 'webhook_failed'
  | 'api_call_made'
  | 'api_call_failed'
  | 'integration_connected'
  | 'integration_disconnected';

export type AuditActorType = 'user' | 'system' | 'webhook';

interface AuditLogRow {
  id: number;
  workspace_id: string;
  provider: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

// ─── Fire-and-forget audit entry insertion ────────────────────────────────────

/**
 * Insert an audit log entry. Fire-and-forget — errors are logged, never thrown.
 * This ensures audit logging never blocks the primary operation.
 */
export async function insertAuditEntry(opts: {
  workspaceId: string;
  provider: string;
  action: AuditAction;
  actorType: AuditActorType;
  actorId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await execute(
      `INSERT INTO integration_audit_log (workspace_id, provider, action, actor_type, actor_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        opts.workspaceId,
        opts.provider,
        opts.action,
        opts.actorType,
        opts.actorId ?? null,
        JSON.stringify(opts.details ?? {}),
      ],
    );
  } catch (err) {
    logger.warn({ err, ...opts }, '[AuditLog] Failed to insert audit entry');
  }
}

// ─── GET /api/workspaces/:id/integrations/audit-log ───────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/integrations/audit-log:
 *   get:
 *     tags: [Integrations]
 *     summary: Get integration audit log for a workspace
 *     operationId: getIntegrationAuditLog
 *     x-rorca-tier: paid
 *     x-rorca-rationale: "Integration audit traces are part of the paid observability/GRC surface and should not be exposed to free-tier automation."
 *     description: Returns a paginated, filterable audit log of all integration actions for a workspace. Supports filtering by provider and action type.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *       - in: query
 *         name: provider
 *         schema:
 *           type: string
 *         description: Filter by integration provider (e.g. github)
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *         description: Filter by action type (e.g. webhook_received)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number (1-indexed)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 25
 *         description: Items per page (max 250)
 *     responses:
 *       200:
 *         description: Paginated audit log entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       workspace_id: { type: string }
 *                       provider: { type: string }
 *                       action: { type: string }
 *                       actor_type: { type: string }
 *                       actor_id: { type: string, nullable: true }
 *                       details: { type: object }
 *                       created_at: { type: string }
 *                 total: { type: integer }
 *                 hasMore: { type: boolean }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *       404:
 *         description: Workspace not found
 *       500:
 *         description: Unable to load audit log
 */
router.get('/audit-log', async (req: Request, res: Response) => {
  const workspaceId = req.params.id;

  // Validate workspace exists
  const workspace = await queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  const pagination = parsePaginationParams(req, { limit: 25 });

  // Build filter conditions
  const conditions: string[] = ['workspace_id = $1'];
  const params: unknown[] = [workspaceId];
  let paramIdx = 2;

  const provider = req.query.provider ? String(req.query.provider) : null;
  if (provider) {
    conditions.push(`provider = $${paramIdx}`);
    params.push(provider);
    paramIdx++;
  }

  const action = req.query.action ? String(req.query.action) : null;
  if (action) {
    conditions.push(`action = $${paramIdx}`);
    params.push(action);
    paramIdx++;
  }

  const whereClause = conditions.join(' AND ');

  const result = await paginateQuery<AuditLogRow>({
    query: `SELECT id, workspace_id, provider, action, actor_type, actor_id, details, created_at
            FROM integration_audit_log WHERE ${whereClause}`,
    countQuery: `SELECT COUNT(*)::int AS total FROM integration_audit_log WHERE ${whereClause}`,
    params,
    pagination,
    orderBy: 'created_at DESC',
    cursorColumn: 'created_at',
    cursorDirection: 'desc',
  });

  res.json({
    items: result.items,
    total: result.total,
    hasMore: result.hasMore,
    page: Math.floor(pagination.offset / pagination.limit) + 1,
    pageSize: pagination.limit,
  });
});

export default router;
