/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';
import { queryOne } from '../../db/index';
import { errorHandler } from '../../lib/error-handler';
import bountyPolicyRouter from '../bounty-policy';

describe('bounty policy runtime principal grants', () => {
  test('runtime can resolve the policy while immutable history remains non-mutable', async () => {
    const privileges = await queryOne<{
      can_read_policy: boolean;
      can_update_policy: boolean;
      can_insert_audit: boolean;
      can_update_audit: boolean;
      can_delete_audit: boolean;
    }>(`SELECT
      has_table_privilege(current_user,'rorca.bounty_feature_policy','SELECT') AS can_read_policy,
      has_column_privilege(current_user,'rorca.bounty_feature_policy','revision','UPDATE') AS can_update_policy,
      has_column_privilege(current_user,'rorca.bounty_feature_policy_audit','revision','INSERT') AS can_insert_audit,
      has_table_privilege(current_user,'rorca.bounty_feature_policy_audit','UPDATE') AS can_update_audit,
      has_table_privilege(current_user,'rorca.bounty_feature_policy_audit','DELETE') AS can_delete_audit`);
    expect(privileges).toEqual({
      can_read_policy: true,
      can_update_policy: true,
      can_insert_audit: true,
      can_update_audit: false,
      can_delete_audit: false,
    });

    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'local-admin', supabaseId: 'local-admin', email: 'local@localhost', role: 'admin' };
      req.authSource = 'local-fallback';
      next();
    });
    app.use('/api/admin/bounty', bountyPolicyRouter);
    app.use(errorHandler);

    const response = await request(app).get('/api/admin/bounty/policy');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      state: expect.stringMatching(/^(disabled|enabled)$/),
      missionMode: 'bounty',
    }));
  });
});
