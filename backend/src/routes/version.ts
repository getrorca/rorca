import { Router, type Request, type Response, type NextFunction } from 'express';
import { query } from '../db/index';
import { detectDbMode } from '../lib/db-strategy';
import { checkAge } from '../lib/age-guard';

const router = Router();

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

async function getCapabilities(): Promise<{ age: boolean; vector: boolean }> {
  const age = await checkAge();
  let vector = false;
  try {
    const rows = await query<ExtensionRow>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'"
    );
    vector = rows.some((row) => row.extname === 'vector');
  } catch {
    vector = false;
  }
  return { age, vector };
}

/**
 * @swagger
 * /api/version:
 *   get:
 *     tags: [Health]
 *     summary: Lightweight version and capability probe
 *     operationId: getVersion
 *     description: Returns the running app version, database mode, and lightweight capability flags used by the frontend to decide whether graph-backed features are available in Lite Mode.
 *     responses:
 *       200:
 *         description: Version and capability payload
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      version: VERSION,
      mode: detectDbMode(),
      capabilities: await getCapabilities(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
