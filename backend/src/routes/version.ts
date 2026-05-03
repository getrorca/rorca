import { Router, type Request, type Response, type NextFunction } from 'express';
import { pool, query, queryOne } from '../db/index';
import { detectDbMode } from '../lib/db-strategy';

const router = Router();

const API_VERSION = '1.0';
const MIN_CLI_VERSION = '0.1.0';

let VERSION = '0.0.1';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
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

async function isAgeAvailableForVersionProbe(): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('RESET ROLE');
    await client.query('RESET request.jwt.claim.sub');
    await client.query('RESET request.jwt.claims');
    await client.query('SET search_path TO rorca, public');
    await client.query(`LOAD 'age'`);
    await client.query('SET search_path = ag_catalog, "$user", public');
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    try {
      await client.query('SET search_path = rorca, public');
    } catch {
      // Best effort cleanup before returning the client to the pool.
    }
    client.release();
  }
}

function hasDockerSidecar(): boolean {
  return detectDbMode() === 'docker';
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
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [schemaVersion, age, vector] = await Promise.all([
      getCurrentSchemaVersion(),
      isAgeAvailableForVersionProbe(),
      hasVectorExtension(),
    ]);

    res.json({
      version: VERSION,
      apiVersion: API_VERSION,
      schemaVersion,
      minCliVersion: MIN_CLI_VERSION,
      mode: detectDbMode(),
      capabilities: {
        pi: true,
        docker: hasDockerSidecar(),
        age,
        vector,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
