/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { Router } from 'express';
import { buildBountyPresentationContract } from '../lib/bounty-presentation-contract';
import { swaggerSpec } from '../lib/swagger';

const router = Router();

/**
 * @swagger
 * /api/contracts/bounty-presentation:
 *   get:
 *     tags: [Bounty]
 *     summary: Read the bounded bounty presentation client contract
 *     operationId: getBountyPresentationContract
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Authenticated local clients may inspect OpenAPI-derived bounty state, blocker, preview, approval-target and receipt contracts; this read-only projection grants no Controller or target-effect authority."
 *     x-rorca-idempotent: true
 *     responses:
 *       200:
 *         description: OpenAPI-derived bounty.presentation.v1 contract used unchanged by REST, MCP, Pi and Hermes
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required: [schemaVersion, source, controllerReceiptMode, reasonCodes, operations, clients, forbiddenCapabilities]
 *               properties:
 *                 schemaVersion: { type: string, enum: [bounty.presentation.v1] }
 *                 source: { type: string, enum: [rest-openapi] }
 *                 controllerReceiptMode: { type: string, enum: [exact-rest-json-no-rewrite] }
 *                 reasonCodes: { type: object, additionalProperties: { type: string } }
 *                 operations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     additionalProperties: false
 *                     required: [operationId, method, path, tier, mcpCallable, input, responses, reasonCodes, receiptMode]
 *                     properties:
 *                       operationId: { type: string }
 *                       method: { type: string, enum: [GET, POST] }
 *                       path: { type: string }
 *                       tier: { type: string, enum: [admin] }
 *                       rationale: { type: string }
 *                       mcpCallable: { type: boolean, enum: [false] }
 *                       input: { type: object }
 *                       responses: { type: object }
 *                       reasonCodes: { type: object, additionalProperties: { type: string } }
 *                       receiptMode: { type: string, enum: [exact-rest-json-no-rewrite] }
 *                 clients: { type: object }
 *                 forbiddenCapabilities:
 *                   type: array
 *                   items: { type: string }
 *       401: { description: Authentication required, reason code AUTH_ERROR }
 */
router.get('/', (_req, res) => {
  res.json(buildBountyPresentationContract(swaggerSpec as never));
});

export default router;
