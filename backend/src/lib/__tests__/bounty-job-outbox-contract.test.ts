/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'lib/bounty-job-outbox.ts'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'lib/bounty-controller.ts'), 'utf8');
const queues = fs.readFileSync(path.join(root, 'lib/pg-boss.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'db/pg-migrations/20260801140000_bounty_job_outbox.sql'), 'utf8');

describe('bounty application outbox contract', () => {
  test('uses only fixed queues created before send/work', () => {
    for (const queue of ['bounty:control', 'bounty:work', 'bounty:reconcile']) {
      expect(queues).toContain(`createQueue('${queue}')`);
      expect(migration).toContain(`'${queue}'`);
    }
    expect(source).not.toMatch(/bounty:\$\{|bounty:'\s*\+/);
  });

  test('controller commits intent without touching pg-boss', () => {
    expect(controller).toContain('bounty_application_outbox');
    expect(controller).not.toContain('boss.send');
    expect(controller).not.toContain('getBoss');
  });

  test('publisher fences crashes and ambiguous or duplicate delivery by UUID', () => {
    expect(source).toContain('FOR UPDATE SKIP LOCKED');
    expect(source).toContain('publish_lease_expires_at<=NOW()');
    expect(source).toContain('observed === row.job_id || await exists()');
    expect(source).toContain("{ id: row.job_id");
    expect(migration).toContain('UNIQUE (job_id)');
  });

  test('worker rechecks revision, epoch, lease, stop state, and package hash', () => {
    for (const fence of ['row.revision', 'row.epoch', 'row.leased', 'row.stopped', 'row.package_hash']) {
      expect(source).toContain(fence);
    }
    expect(source).toContain("row.state !== 'active'");
    expect(source).toContain("reason: 'lease_active'");
  });
});
