/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── Telemetry Routes ─────────────────────────────────────────────────────────
// PR-005: Privacy-first telemetry management

import { Router, Request, Response } from 'express';
import { isTelemetryEnabled } from '../lib/telemetry-config';

const router = Router();

/**
 * @swagger
 * /api/telemetry/status:
 *   get:
 *     tags: [Telemetry]
 *     summary: Get telemetry status
 *     operationId: getTelemetryStatus
 *     description: Returns whether telemetry is enabled. This is read-only and determined by RORCA_TELEMETRY env var. For UI to display telemetry toggle state.
 *     responses:
 *       200:
 *         description: Telemetry status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled: { type: boolean, description: "Whether telemetry is enabled" }
 *                 note: { type: string, description: "Info message about telemetry" }
 */
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    enabled: isTelemetryEnabled(),
    note: 'Telemetry status is read-only and set via RORCA_TELEMETRY environment variable (0=off, 1=on)',
  });
});

export default router;
