/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router } from 'express';
import { getPublishedMcpTools } from '../lib/mcp-http';
import { swaggerSpec } from '../lib/swagger';

const router = Router();

/**
 * @swagger
 * /api/mcp/tools:
 *   get:
 *     summary: List all live Rorca MCP tools
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only MCP capability discovery is safe for local automation and should reflect the actual live tool surface."
 *     x-rorca-public-api: true
 *     description: >
 *       Returns the live MCP tool catalog derived from the same OpenAPI + alias source
 *       that powers the HTTP/stdio MCP servers. This avoids drift between docs,
 *       extensions, and the actual exposed MCP surface.
 *     tags:
 *       - MCP
 *     responses:
 *       200:
 *         description: List of live MCP tools
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tools:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required:
 *                       - name
 *                       - description
 *                       - category
 *                       - inputSchema
 *                       - requiredParams
 *                     properties:
 *                       name:
 *                         type: string
 *                         example: rorca_create_spec
 *                       description:
 *                         type: string
 *                         example: Create a Rorca spec from explicit drafted content
 *                       category:
 *                         type: string
 *                         example: Specs & Pipeline
 *                       inputSchema:
 *                         type: object
 *                         additionalProperties: true
 *                       requiredParams:
 *                         type: array
 *                         items:
 *                           type: string
 */
router.get('/', (_req, res) => {
  res.json({ tools: getPublishedMcpTools(swaggerSpec as any) });
});

export default router;
