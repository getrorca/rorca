/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { answerOperatorChat, type OperatorChatMode, type OperatorChatRequest } from '../lib/operator-chat';
import { ValidationError } from '../lib/errors';

const router = Router();

function stringField(body: Record<string, unknown>, key: string, max = 4_000): string | undefined {
  const value = body[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function boolField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

function numberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordField(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = body[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function modeField(body: Record<string, unknown>): OperatorChatMode | undefined {
  const value = body.mode;
  return value === 'general' || value === 'coding' || value === 'research' || value === 'genesis' ? value : undefined;
}

function parseRequest(body: unknown): OperatorChatRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  const data = body as Record<string, unknown>;
  const input = stringField(data, 'input');
  if (!input) throw new ValidationError('Missing required field: input');
  if (input.length > 4_000) throw new ValidationError('Operator-chat input exceeds 4000 characters');
  const request: OperatorChatRequest = {
    input,
    workspaceId: stringField(data, 'workspaceId', 160),
    mode: modeField(data),
    source: stringField(data, 'source', 80),
    model: stringField(data, 'model', 160),
    useModel: boolField(data, 'useModel'),
    maxTokens: numberField(data, 'maxTokens'),
    operatorContext: recordField(data, 'operatorContext'),
  };
  if (request.maxTokens !== undefined && (request.maxTokens < 256 || request.maxTokens > 2_000)) {
    throw new ValidationError('maxTokens must be between 256 and 2000');
  }
  return request;
}

/**
 * @swagger
 * /api/operator-chat/query:
 *   post:
 *     tags: [Operator Chat]
 *     summary: Read-only operator chat answer for Hermes/ChatOps clients
 *     operationId: queryOperatorChat
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only operator Q&A surface for local ChatOps/MCP clients; it answers from bounded context and cannot mutate specs, runs, memory, secrets, or shell state."
 *     x-rorca-public-api: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [input]
 *             properties:
 *               input: { type: string, description: User/operator question }
 *               workspaceId: { type: string }
 *               mode: { type: string, enum: [general, coding, research, genesis] }
 *               source: { type: string }
 *               model: { type: string, description: Optional model override for model synthesis }
 *               useModel: { type: boolean, description: Request model synthesis when safe and configured }
 *               maxTokens: { type: integer, minimum: 256, maximum: 2000 }
 *               operatorContext: { type: object, description: Redacted caller context used for grounding }
 *     responses:
 *       200:
 *         description: Read-only operator answer with provenance
 *       400:
 *         description: Invalid request
 */
router.post('/query', async (req: Request, res: Response) => {
  const request = parseRequest(req.body);
  const response = await answerOperatorChat(request);
  res.json(response);
});

export default router;
