/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { generateCsrfToken, setCsrfCookie } from '../lib/csrf';
import { authRequired, LOCAL_ADMIN } from '../lib/auth-utils';
import { getEffectiveUser } from '../lib/get-user';

const router = Router();

router.get('/csrf-token', (_req: Request, res: Response) => {
  const token = generateCsrfToken();
  setCsrfCookie(res, token);
  res.json({ token });
});

router.get('/me', authRequired, async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  res.json({ user: user ?? LOCAL_ADMIN });
});

router.post('/resend-verification', (_req: Request, res: Response) => {
  res.json({ ok: true, mode: 'local-oss' });
});

export default router;
