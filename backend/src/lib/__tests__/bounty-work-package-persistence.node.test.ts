/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = fs.existsSync(path.join(sourceRoot, 'lib/bounty-controller.ts')) ? sourceRoot : path.join(process.cwd(), 'src');
const migration = fs.readFileSync(path.join(root, 'db/pg-migrations/20260803120000_bounty_work_package_routing.sql'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'lib/bounty-controller.ts'), 'utf8');
const route = fs.readFileSync(path.join(root, 'routes/bounty-work-packages.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');

test('migration persists immutable ordered route identity and separated reports', () => {
  for (const column of [
    'route_input_hash', 'route_hash', 'route_policy_hash', 'objective_id', 'objective_class',
    'role_name', 'context_tokens', 'model_tier', 'selected_hashes', 'omissions',
    'reason_codes', 'route_body',
  ]) assert.match(migration, new RegExp(`\\b${column}\\b`));
  assert.match(migration, /work package route is immutable/);
  assert.match(migration, /CREATE TABLE bounty_work_package_route_decisions/);
  assert.match(migration, /work package route decision is immutable/);
  for (const dimension of ['can_create', 'reason_codes', 'omissions', 'reports', 'telemetry', 'decision_body']) {
    assert.match(migration, new RegExp(`\\b${dimension}\\b`));
  }
  assert.match(migration, /BEFORE UPDATE OR DELETE ON bounty_work_package_route_decisions/);
  assert.match(migration, /release_sequence/);
  assert.doesNotMatch(migration, /pgboss\.|CREATE\s+TABLE\s+pgboss/i);
});

test('controller is the persistence boundary and replays by deterministic input hash', () => {
  assert.match(controller, /routeBountyWorkPackages\(command\.routeInput\)/);
  assert.match(controller, /g\.input_identity=\$3/);
  assert.match(controller, /ORDER BY w\.release_sequence/);
  assert.match(controller, /BOUNTY_ROUTE_BLOCKED/);
  assert.match(controller, /INSERT INTO bounty_work_package_route_decisions/);
  assert.match(controller, /routed\.reports\.routing\.omitted/);
  assert.match(controller, /reports: outcome\.blocked\.reports/);
  assert.match(controller, /telemetry: outcome\.blocked\.telemetry/);
  assert.ok(
    controller.indexOf('INSERT INTO bounty_work_package_route_decisions') < controller.indexOf('if (!routed.canCreate) return { blocked: routed }'),
    'blocked decision must commit before the controller returns it for rejection',
  );
  assert.match(controller, /INSERT INTO bounty_work_packages/);
  assert.doesNotMatch(route, /INSERT\s+INTO|UPDATE\s+bounty_|DELETE\s+FROM/i);
});

test('admin route is credential-authenticated, governed in Swagger, and mounted', () => {
  assert.match(route, /req\.authSource !== 'bearer'/);
  assert.match(route, /x-rorca-tier: admin/);
  assert.match(route, /x-rorca-rationale:/);
  assert.match(route, /BountyRouteInputSchema/);
  assert.match(server, /app\.use\('\/api\/admin\/bounty\/work-packages', bountyWorkPackagesRouter\)/);
});
