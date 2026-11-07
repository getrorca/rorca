/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router } from 'express';
import { approveCandidateFromRequest, createCandidateFromRequest } from './context-candidates';

const router = Router();

/**
 * @swagger
 * /api/memory/candidates:
 *   post:
 *     tags: [Memory]
 *     summary: Create a pending memory candidate from a manual sidecar observation
 *     operationId: createMemoryCandidate
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Manual sidecar candidate creation stores unapproved pending review items only and is safe for local automation retries."
 *     x-rorca-public-api: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, suggestedCategory, title, rule]
 *             properties:
 *               workspaceId: { type: string }
 *               sourceRef: { type: string }
 *               suggestedCategory: { type: string, enum: [Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha] }
 *               title: { type: string }
 *               rule: { type: string }
 *               context: { type: string }
 *               relatedFiles: { type: array, items: { type: string } }
 *               confidence: { type: string, enum: [high, medium, low] }
 *               trustTier: { type: string, enum: [agent_observation, working_note, engineering_decision, approved_policy, verified_fact] }
 *               idempotencyKey: { type: string }
 *     responses:
 *       201: { description: Created pending memory candidate }
 *       200: { description: Existing memory candidate returned for an idempotent duplicate submission }
 *       400: { description: Invalid payload }
 *       404: { description: Workspace or context event not found }
 */
router.post('/', createCandidateFromRequest);

/**
 * @swagger
 * /api/memory/candidates/{id}/approve:
 *   post:
 *     tags: [Memory]
 *     summary: Approve a memory candidate and promote it to durable Rorca memory
 *     operationId: approveMemoryCandidate
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Manual sidecar candidate approval is a stable local-operator action gated by explicit operator auto-approval config after a pending candidate is created."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Candidate approved and memory promoted }
 *       400: { description: Invalid payload }
 *       404: { description: Candidate not found }
 *       409: { description: Candidate cannot be approved }
 */
router.post('/:id/approve', approveCandidateFromRequest);

export default router;
