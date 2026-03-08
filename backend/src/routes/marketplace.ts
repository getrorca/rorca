import { Router, Request, Response } from 'express';
import { sanitizeSpec } from '../lib/spec-sanitizer';

const router = Router();

/**
 * @swagger
 * /api/marketplace/preview-sanitize:
 *   post:
 *     tags: [Marketplace]
 *     summary: Preview PII/secret sanitization of a spec before publishing
 *     operationId: previewSanitize
 *     description: |
 *       Accepts a spec JSON object and runs the sanitizer across all string fields
 *       (recursively). Returns the sanitized copy and a redaction report so the user
 *       can confirm what will be scrubbed before they publish to the community
 *       marketplace.  No data is persisted by this endpoint.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [spec]
 *             properties:
 *               spec:
 *                 type: object
 *                 description: Raw spec JSON to sanitize
 *     responses:
 *       200:
 *         description: Sanitized spec and redaction report
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sanitized:
 *                   type: object
 *                   description: Sanitized copy of the input spec
 *                 redactionCount:
 *                   type: integer
 *                   description: Total number of values redacted
 *                 redactions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       field:
 *                         type: string
 *                         description: JSON path of the field containing the secret
 *                       pattern:
 *                         type: string
 *                         description: Name of the pattern that matched
 *                       original_preview:
 *                         type: string
 *                         description: First 4 + last 4 chars of the original value
 *       400:
 *         description: Missing or invalid spec field
 */
router.post('/preview-sanitize', (req: Request, res: Response) => {
  const { spec } = req.body as { spec?: unknown };

  if (spec === undefined || spec === null) {
    res.status(400).json({ error: 'Missing required field: spec' });
    return;
  }

  const result = sanitizeSpec(spec);
  res.json(result);
});

export default router;
