/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';
import { pathToFileURL } from 'url';
import PgBoss from 'pg-boss';
import { Pool } from 'pg';
import { getPgBossSchemaName } from '../lib/pg-boss-schema';
import {
  activateQualificationBoundary,
  buildQualificationEvidence,
  cleanupQualificationArtifacts,
  createQualificationQueue,
  deleteOwnedQualificationRows,
  deleteQualificationQueue,
  type QualificationBoundary,
} from '../lib/qualification-isolation';

interface ScenarioResult {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

interface ScenarioContext {
  boundary: Readonly<QualificationBoundary>;
  createQueue(purpose: string): Promise<string>;
  deleteOwnedRows(table: string, ownershipColumn: string, ownershipValue: string): Promise<number>;
}

interface ScenarioModule {
  runQualification?: (context: ScenarioContext) => Promise<ScenarioResult | void>;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.RORCA_QUALIFICATION_DATABASE_URL ?? '';
  const scenarioPath = process.env.RORCA_QUALIFICATION_SCENARIO ?? '';
  if (!path.isAbsolute(scenarioPath)) throw new Error('qualification scenario path is not absolute');

  // The pool performs only the read-only server-truth preflight until activation
  // succeeds. No scenario module is imported and no fixture path exists earlier.
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let boundary: QualificationBoundary | undefined;
  let boss: PgBoss | undefined;
  const queues: string[] = [];
  let primaryError: unknown;
  try {
    ({ boundary } = await activateQualificationBoundary(pool, process.env));
    process.chdir(boundary.repositoryRoot);

    const scenario = await import(pathToFileURL(scenarioPath).href) as ScenarioModule;
    if (typeof scenario.runQualification !== 'function') {
      throw new Error('qualification scenario must export runQualification(context)');
    }

    const context: ScenarioContext = {
      boundary: Object.freeze({ ...boundary }),
      async createQueue(purpose: string): Promise<string> {
        if (!boss) {
          boss = new PgBoss({ connectionString: databaseUrl, schema: getPgBossSchemaName() });
          await boss.start();
        }
        const queue = await createQualificationQueue(boss, boundary!, purpose);
        queues.push(queue);
        return queue;
      },
      async deleteOwnedRows(table, ownershipColumn, ownershipValue): Promise<number> {
        return deleteOwnedQualificationRows(pool, boundary!, table, ownershipColumn, ownershipValue);
      },
    };

    const result = await scenario.runQualification(context) ?? {};
    const evidence = buildQualificationEvidence(boundary, result.before ?? {}, result.after ?? {});
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch (error) {
    primaryError = error;
  } finally {
    let cleanupError: unknown;
    if (boss && boundary) {
      for (const queue of queues.reverse()) {
        try {
          await deleteQualificationQueue(boss, boundary, queue);
        } catch (error) {
          cleanupError ??= error;
        }
      }
      try {
        await boss.stop({ graceful: true, timeout: 5_000 });
      } catch (error) {
        cleanupError ??= error;
      }
    }
    await pool.end().catch(error => { cleanupError ??= error; });
    if (boundary) {
      try {
        cleanupQualificationArtifacts(boundary);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (primaryError || cleanupError) throw primaryError ?? cleanupError;
  }
}

main().catch(() => {
  // Never print credentials, scenario payloads, or private absolute paths.
  process.stderr.write('[wave-qualification] semantic failure (details redacted)\n');
  process.exitCode = 1;
});
