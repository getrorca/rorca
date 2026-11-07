/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * FIN-001: FinOps billing-profile settings.
 *
 * CRUD surface over the canonical `billing_profiles` table. A billing profile
 * declares how a provider/model is paid for (metered API, subscription, managed,
 * free/local, unknown), the monthly subscription cost and allocation basis, the
 * effective date window, the workspace scope, free-form notes, and enabled state.
 *
 * Input is validated at the route boundary and failures throw AppError subclasses
 * (ValidationError / NotFoundError / ConflictError). Internal code trusts the
 * normalized BillingProfileInput thereafter.
 */

import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db/index';
import { ValidationError, NotFoundError, ConflictError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import {
  BILLING_MODES,
  ALLOCATION_BASES,
  isBillingMode,
  isAllocationBasis,
  rowToBillingProfile,
  windowsOverlap,
  type BillingProfileRow,
  type BillingProfileInput,
} from '../lib/finops-types';

const router = Router();

// ─── Validation ──────────────────────────────────────────────────────────────

/** Parse an ISO timestamp, throwing ValidationError on a malformed value. */
function parseIsoOrThrow(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} must be a non-empty ISO date string`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ValidationError(`${field} is not a valid ISO date`);
  }
  return new Date(ms).toISOString();
}

/**
 * Validate and normalize a raw request body into a BillingProfileInput.
 * Throws ValidationError for any boundary violation.
 */
function validateBillingProfileInput(body: unknown): BillingProfileInput {
  const b = (body ?? {}) as Record<string, unknown>;

  // provider — required, non-empty
  if (typeof b.provider !== 'string' || b.provider.trim() === '') {
    throw new ValidationError('provider is required');
  }
  const provider = b.provider.trim();

  // billing_mode — required enum
  if (!isBillingMode(b.billing_mode)) {
    throw new ValidationError(`billing_mode must be one of: ${BILLING_MODES.join(', ')}`);
  }
  const billingMode = b.billing_mode;

  // model_pattern — optional string
  let modelPattern: string | null = null;
  if (b.model_pattern != null) {
    if (typeof b.model_pattern !== 'string') {
      throw new ValidationError('model_pattern must be a string');
    }
    modelPattern = b.model_pattern.trim() === '' ? null : b.model_pattern.trim();
  }

  // workspace_id — optional (null = global profile)
  let workspaceId: string | null = null;
  if (b.workspace_id != null) {
    if (typeof b.workspace_id !== 'string' || b.workspace_id.trim() === '') {
      throw new ValidationError('workspace_id must be a non-empty string when provided');
    }
    workspaceId = b.workspace_id.trim();
  }

  // allocation_basis — optional enum, default 'none'
  let allocationBasis = 'none' as BillingProfileInput['allocationBasis'];
  if (b.allocation_basis != null) {
    if (!isAllocationBasis(b.allocation_basis)) {
      throw new ValidationError(`allocation_basis must be one of: ${ALLOCATION_BASES.join(', ')}`);
    }
    allocationBasis = b.allocation_basis;
  }

  // monthly_cost_usd — required for subscription, forbidden otherwise
  let monthlyCostUsd: number | null = null;
  if (b.monthly_cost_usd != null) {
    if (typeof b.monthly_cost_usd !== 'number' || !Number.isFinite(b.monthly_cost_usd)) {
      throw new ValidationError('monthly_cost_usd must be a finite number');
    }
    if (b.monthly_cost_usd < 0) {
      throw new ValidationError('monthly_cost_usd cannot be negative');
    }
    monthlyCostUsd = b.monthly_cost_usd;
  }
  if (billingMode === 'subscription' && monthlyCostUsd == null) {
    throw new ValidationError('monthly_cost_usd is required when billing_mode is subscription');
  }
  if (billingMode !== 'subscription' && monthlyCostUsd != null) {
    throw new ValidationError('monthly_cost_usd is only allowed when billing_mode is subscription');
  }

  // effective_from — optional, default now
  const effectiveFrom = b.effective_from != null
    ? parseIsoOrThrow('effective_from', b.effective_from)
    : new Date().toISOString();

  // effective_to — optional (null = open-ended)
  let effectiveTo: string | null = null;
  if (b.effective_to != null) {
    effectiveTo = parseIsoOrThrow('effective_to', b.effective_to);
    if (new Date(effectiveTo).getTime() <= new Date(effectiveFrom).getTime()) {
      throw new ValidationError('effective_to must be after effective_from');
    }
  }

  // notes — optional string
  let notes: string | null = null;
  if (b.notes != null) {
    if (typeof b.notes !== 'string') {
      throw new ValidationError('notes must be a string');
    }
    notes = b.notes;
  }

  // enabled — optional boolean, default true
  let enabled = true;
  if (b.enabled != null) {
    if (typeof b.enabled !== 'boolean') {
      throw new ValidationError('enabled must be a boolean');
    }
    enabled = b.enabled;
  }

  return {
    workspaceId,
    provider,
    modelPattern,
    billingMode,
    monthlyCostUsd,
    allocationBasis,
    effectiveFrom,
    effectiveTo,
    notes,
    enabled,
  };
}

/**
 * Ensure no other ENABLED profile for the same (workspace, provider, model_pattern)
 * has an overlapping effective-date window. A conflicting window would make
 * billing-mode resolution ambiguous at a point in time.
 *
 * @param excludeId profile id to skip (used on update so a row never conflicts with itself)
 */
async function assertNoOverlap(input: BillingProfileInput, excludeId?: number): Promise<void> {
  if (!input.enabled) return; // disabled profiles never conflict

  // NULL-safe matching on workspace_id and model_pattern via IS NOT DISTINCT FROM.
  const rows = await query<Pick<BillingProfileRow, 'id' | 'effective_from' | 'effective_to'>>(
    `SELECT id, effective_from, effective_to
       FROM billing_profiles
      WHERE provider = $1
        AND workspace_id IS NOT DISTINCT FROM $2
        AND model_pattern IS NOT DISTINCT FROM $3
        AND enabled = TRUE
        AND ($4::bigint IS NULL OR id <> $4)`,
    [input.provider, input.workspaceId, input.modelPattern, excludeId ?? null],
  );

  for (const row of rows) {
    if (windowsOverlap(input.effectiveFrom, input.effectiveTo, row.effective_from, row.effective_to)) {
      throw new ConflictError(
        `An enabled billing profile (#${row.id}) for provider '${input.provider}' already covers an overlapping effective-date window`,
      );
    }
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/finops/billing-profiles:
 *   get:
 *     tags: [FinOps]
 *     summary: List billing profiles
 *     operationId: listBillingProfiles
 *     description: Lists billing profiles, optionally filtered by workspace. Pass workspace_id to scope to a workspace; omit it to also include global (workspace-less) profiles.
 *     x-rorca-tier: paid
 *     x-rorca-capability: finops
 *     x-rorca-rationale: "Billing-profile configuration is part of the commercial FinOps accounting surface and must stay outside the free CLI/MCP contract."
 *     parameters:
 *       - in: query
 *         name: workspace_id
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: enabled
 *         required: false
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: List of billing profiles
 *       400:
 *         description: Invalid query parameter
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { workspace_id, enabled } = req.query as { workspace_id?: string; enabled?: string };

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (workspace_id != null) {
      // Include both the workspace's own profiles and global profiles.
      params.push(workspace_id);
      clauses.push(`(workspace_id = $${params.length} OR workspace_id IS NULL)`);
    }

    if (enabled != null) {
      if (enabled !== 'true' && enabled !== 'false') {
        throw new ValidationError('enabled must be "true" or "false"');
      }
      params.push(enabled === 'true');
      clauses.push(`enabled = $${params.length}`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await query<BillingProfileRow>(
      `SELECT * FROM billing_profiles ${where}
       ORDER BY workspace_id NULLS FIRST, provider, effective_from DESC`,
      params,
    );

    res.json({ profiles: rows.map(rowToBillingProfile) });
  } catch (error) {
    handleRouteError(res, error, '[FinOps] List billing profiles');
  }
});

/**
 * @swagger
 * /api/finops/billing-profiles/{id}:
 *   get:
 *     tags: [FinOps]
 *     summary: Get a billing profile
 *     operationId: getBillingProfile
 *     description: Returns a single billing profile by id.
 *     x-rorca-tier: paid
 *     x-rorca-capability: finops
 *     x-rorca-rationale: "Billing-profile configuration is part of the commercial FinOps accounting surface and must stay outside the free CLI/MCP contract."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: The billing profile
 *       400:
 *         description: Invalid id
 *       404:
 *         description: Billing profile not found
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('id must be a positive integer');
    }
    const row = await queryOne<BillingProfileRow>(
      'SELECT * FROM billing_profiles WHERE id = $1',
      [id],
    );
    if (!row) {
      throw new NotFoundError('Billing profile', String(id));
    }
    res.json({ profile: rowToBillingProfile(row) });
  } catch (error) {
    handleRouteError(res, error, '[FinOps] Get billing profile');
  }
});

/**
 * @swagger
 * /api/finops/billing-profiles:
 *   post:
 *     tags: [FinOps]
 *     summary: Create a billing profile
 *     operationId: createBillingProfile
 *     description: Creates a billing profile. Rejects with 409 if an enabled profile for the same workspace/provider/model already covers an overlapping effective-date window.
 *     x-rorca-tier: paid
 *     x-rorca-capability: finops
 *     x-rorca-rationale: "Writing billing-profile configuration mutates commercial FinOps accounting state and must never be reachable from the free CLI/MCP contract."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [provider, billing_mode]
 *             properties:
 *               workspace_id: { type: string, nullable: true }
 *               provider: { type: string }
 *               model_pattern: { type: string, nullable: true }
 *               billing_mode: { type: string, enum: [metered_api, subscription, managed, free_local, unknown] }
 *               monthly_cost_usd: { type: number, nullable: true }
 *               allocation_basis: { type: string, enum: [none, even, by_tokens, by_runs], default: none }
 *               effective_from: { type: string, format: date-time }
 *               effective_to: { type: string, format: date-time, nullable: true }
 *               notes: { type: string, nullable: true }
 *               enabled: { type: boolean, default: true }
 *     responses:
 *       201:
 *         description: Billing profile created
 *       400:
 *         description: Validation error
 *       409:
 *         description: Overlapping effective-date window
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const input = validateBillingProfileInput(req.body);

    if (input.workspaceId != null) {
      const ws = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [input.workspaceId]);
      if (!ws) {
        throw new NotFoundError('Workspace', input.workspaceId);
      }
    }

    await assertNoOverlap(input);

    const row = await queryOne<BillingProfileRow>(
      `INSERT INTO billing_profiles
         (workspace_id, provider, model_pattern, billing_mode, monthly_cost_usd,
          allocation_basis, effective_from, effective_to, notes, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.workspaceId,
        input.provider,
        input.modelPattern,
        input.billingMode,
        input.monthlyCostUsd,
        input.allocationBasis,
        input.effectiveFrom,
        input.effectiveTo,
        input.notes,
        input.enabled,
      ],
    );

    res.status(201).json({ profile: rowToBillingProfile(row!) });
  } catch (error) {
    handleRouteError(res, error, '[FinOps] Create billing profile');
  }
});

/**
 * @swagger
 * /api/finops/billing-profiles/{id}:
 *   put:
 *     tags: [FinOps]
 *     summary: Update a billing profile
 *     operationId: updateBillingProfile
 *     description: Replaces a billing profile by id. Rejects with 409 if the new effective-date window overlaps another enabled profile for the same workspace/provider/model.
 *     x-rorca-tier: paid
 *     x-rorca-capability: finops
 *     x-rorca-rationale: "Writing billing-profile configuration mutates commercial FinOps accounting state and must never be reachable from the free CLI/MCP contract."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [provider, billing_mode]
 *     responses:
 *       200:
 *         description: Billing profile updated
 *       400:
 *         description: Validation error
 *       404:
 *         description: Billing profile not found
 *       409:
 *         description: Overlapping effective-date window
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('id must be a positive integer');
    }

    const existing = await queryOne<{ id: number }>('SELECT id FROM billing_profiles WHERE id = $1', [id]);
    if (!existing) {
      throw new NotFoundError('Billing profile', String(id));
    }

    const input = validateBillingProfileInput(req.body);

    if (input.workspaceId != null) {
      const ws = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [input.workspaceId]);
      if (!ws) {
        throw new NotFoundError('Workspace', input.workspaceId);
      }
    }

    await assertNoOverlap(input, id);

    const row = await queryOne<BillingProfileRow>(
      `UPDATE billing_profiles SET
         workspace_id = $1,
         provider = $2,
         model_pattern = $3,
         billing_mode = $4,
         monthly_cost_usd = $5,
         allocation_basis = $6,
         effective_from = $7,
         effective_to = $8,
         notes = $9,
         enabled = $10,
         updated_at = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        input.workspaceId,
        input.provider,
        input.modelPattern,
        input.billingMode,
        input.monthlyCostUsd,
        input.allocationBasis,
        input.effectiveFrom,
        input.effectiveTo,
        input.notes,
        input.enabled,
        id,
      ],
    );

    res.json({ profile: rowToBillingProfile(row!) });
  } catch (error) {
    handleRouteError(res, error, '[FinOps] Update billing profile');
  }
});

/**
 * @swagger
 * /api/finops/billing-profiles/{id}:
 *   delete:
 *     tags: [FinOps]
 *     summary: Delete a billing profile
 *     operationId: deleteBillingProfile
 *     description: Permanently removes a billing profile by id.
 *     x-rorca-tier: paid
 *     x-rorca-capability: finops
 *     x-rorca-rationale: "Deleting billing-profile configuration mutates commercial FinOps accounting state and must never be reachable from the free CLI/MCP contract."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Billing profile deleted
 *       400:
 *         description: Invalid id
 *       404:
 *         description: Billing profile not found
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('id must be a positive integer');
    }
    const result = await execute('DELETE FROM billing_profiles WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      throw new NotFoundError('Billing profile', String(id));
    }
    res.json({ deleted: id });
  } catch (error) {
    handleRouteError(res, error, '[FinOps] Delete billing profile');
  }
});

export default router;
