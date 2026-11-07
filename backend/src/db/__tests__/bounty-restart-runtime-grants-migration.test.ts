/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { queryOne } from '../index';
import { reconcileAllBountyMissionsOnRestart } from '../../lib/bounty-mission-control';

const migration = fs.readFileSync(path.join(
  __dirname,
  '../pg-migrations/20260818122000_bounty_restart_reconciliation_runtime_grants.sql',
), 'utf8');

describe('bounty restart reconciliation runtime grants', () => {
  test('keeps mutations column-bounded and never grants delete or schema authority', () => {
    expect(migration).toContain('GRANT SELECT ON TABLE rorca.bounty_missions');
    expect(migration).toContain('GRANT UPDATE (state) ON TABLE rorca.bounty_missions');
    expect(migration).toContain('GRANT UPDATE (released_at) ON TABLE rorca.bounty_effect_reservations');
    expect(migration).toContain('GRANT INSERT (workspace_id, mission_id, reason) ON TABLE rorca.bounty_holds');
    expect(migration).not.toMatch(/GRANT\s+(?:DELETE|TRUNCATE|REFERENCES|TRIGGER|CREATE)/i);
    expect(migration).not.toMatch(/GRANT\s+UPDATE\s+ON/i);
  });

  test('gives the split runtime principal exactly the restart operations it executes', async () => {
    const privileges = await queryOne<{
      missionsSelect: boolean;
      missionsStateUpdate: boolean;
      missionsDelete: boolean;
      operationsStateUpdate: boolean;
      reservationsReleaseUpdate: boolean;
      outboxCancellationUpdate: boolean;
      leasesExpiryUpdate: boolean;
      processesStateUpdate: boolean;
      holdsInsert: boolean;
    }>(`SELECT
      has_table_privilege(current_user, 'rorca.bounty_missions', 'SELECT') AS "missionsSelect",
      has_column_privilege(current_user, 'rorca.bounty_missions', 'state', 'UPDATE') AS "missionsStateUpdate",
      has_table_privilege(current_user, 'rorca.bounty_missions', 'DELETE') AS "missionsDelete",
      has_column_privilege(current_user, 'rorca.bounty_operations', 'state', 'UPDATE') AS "operationsStateUpdate",
      has_column_privilege(current_user, 'rorca.bounty_effect_reservations', 'released_at', 'UPDATE') AS "reservationsReleaseUpdate",
      has_column_privilege(current_user, 'rorca.bounty_application_outbox', 'cancelled_at', 'UPDATE')
        AND has_column_privilege(current_user, 'rorca.bounty_application_outbox', 'cancellation_reason', 'UPDATE') AS "outboxCancellationUpdate",
      has_column_privilege(current_user, 'rorca.bounty_leases', 'expires_at', 'UPDATE') AS "leasesExpiryUpdate",
      has_column_privilege(current_user, 'rorca.bounty_worker_processes', 'state', 'UPDATE') AS "processesStateUpdate",
      has_table_privilege(current_user, 'rorca.bounty_holds', 'INSERT') AS "holdsInsert"`);

    expect(privileges).toEqual({
      missionsSelect: true,
      missionsStateUpdate: true,
      missionsDelete: false,
      operationsStateUpdate: true,
      reservationsReleaseUpdate: true,
      outboxCancellationUpdate: true,
      leasesExpiryUpdate: true,
      processesStateUpdate: true,
      holdsInsert: false,
    });
    expect(await reconcileAllBountyMissionsOnRestart()).toEqual([]);
  });
});
