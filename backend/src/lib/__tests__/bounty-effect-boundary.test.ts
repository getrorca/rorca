/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { errorHandler } from '../error-handler';
import { requireBountyEffectsEnabled } from '../bounty-effect-boundary';
import { BOUNTY_FEATURE_DISABLED_REASON_CODE } from '../bounty-feature-policy';

const disabledPolicy = {
  state: 'disabled' as const,
  enabled: false,
  missionMode: 'bounty' as const,
  revision: 0,
  auditIdentity: 'system:default-disabled',
  authoritySource: 'system_default' as const,
  updatedAt: null,
};

describe('bounty mutation/effect middleware', () => {
  test('returns the stable disabled code before an effect handler runs', async () => {
    const effect = jest.fn((_req: Request, res: Response) => res.status(202).json({ accepted: true }));
    const app = express();
    app.post('/effect', requireBountyEffectsEnabled(async () => disabledPolicy), effect);
    app.use(errorHandler);

    const response = await request(app).post('/effect');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: BOUNTY_FEATURE_DISABLED_REASON_CODE,
      details: { reasonCode: BOUNTY_FEATURE_DISABLED_REASON_CODE },
    });
    expect(effect).not.toHaveBeenCalled();
  });
});
