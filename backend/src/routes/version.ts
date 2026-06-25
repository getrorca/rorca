/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { query, queryOne } from '../db/index';
import { getDatabaseCapability } from '../lib/db-strategy';

const router = Router();

const API_VERSION = '1.0';
const MIN_CLI_VERSION = '0.1.0';

let VERSION = '0.0.1';
try {
  VERSION = (require('../../package.json') as { version: string }).version;
} catch {
  // Compiled builds may not expose package.json.
}

interface ExtensionRow {
  extname: string;
}

interface SchemaVersionRow {
  version: string | null;
}

async function getCurrentSchemaVersion(): Promise<string | null> {
  try {
    const row = await queryOne<SchemaVersionRow>(
      'SELECT MAX(version)::text AS version FROM public.schema_migrations',
    );
    return row?.version ?? null;
  } catch {
    return null;
  }
}

async function hasVectorExtension(): Promise<boolean> {
  try {
    const rows = await query<ExtensionRow>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    return rows.some((row) => row.extname === 'vector');
  } catch {
    return false;
  }
}

function hasDockerSidecar(dbMode: 'native' | 'docker' | 'byop'): boolean {
  return dbMode === 'docker';
}

/**
 * @swagger
 * /api/version:
 *   get:
 *     tags: [Health]
 *     summary: Backend version and compatibility metadata
 *     operationId: getVersion
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Version metadata is part of the stable compatibility contract for the open-source CLI and is read-only."
 *     x-rorca-public-api: true
 *     description: Returns backend package version, API contract version, current schema migration version, minimum compatible CLI version, and additive capability flags for CLI compatibility checks.
 *     responses:
 *       200:
 *         description: Version compatibility payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required:
 *                 - version
 *                 - apiVersion
 *                 - schemaVersion
 *                 - minCliVersion
 *                 - capabilities
 *               properties:
 *                 version:
 *                   type: string
 *                 apiVersion:
 *                   type: string
 *                   description: Semver for the public API contract. Only changes on breaking contract changes.
 *                 schemaVersion:
 *                   type: string
 *                   nullable: true
 *                   description: Highest applied schema_migrations version as a string.
 *                 minCliVersion:
 *                   type: string
 *                 mode:
 *                   type: string
 *                   enum: [native, docker, byop]
 *                 capabilities:
 *                   type: object
 *                   required:
 *                     - pi
 *                     - docker
 *                     - age
 *                   properties:
 *                     pi:
 *                       type: boolean
 *                     docker:
 *                       type: boolean
 *                     age:
 *                       type: boolean
 *                     vector:
 *                       type: boolean
 *                 databaseCapability:
 *                   type: object
 *                   description: Canonical database runtime capability model used by frontend and operators.
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [schemaVersion, databaseCapability, vector] = await Promise.all([
      getCurrentSchemaVersion(),
      getDatabaseCapability(),
      hasVectorExtension(),
    ]);

    res.json({
      version: VERSION,
      apiVersion: API_VERSION,
      schemaVersion,
      minCliVersion: MIN_CLI_VERSION,
      mode: databaseCapability.dbMode,
      capabilities: {
        pi: true,
        docker: hasDockerSidecar(databaseCapability.dbMode),
        age: databaseCapability.extensions.age,
        vector: databaseCapability.extensions.vector || vector,
      },
      databaseCapability,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
