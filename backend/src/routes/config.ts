import { Router, Request, Response } from 'express';
import { agentType, agentModel } from '../lib/config';

const router = Router();

/**
 * @swagger
 * /api/config:
 *   get:
 *     summary: Get agent configuration
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Current agent configuration
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({ agentType, agentModel });
});

export default router;
