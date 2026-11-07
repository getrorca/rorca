/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { ProductionCaidoTransport } from '../bounty-production-caido';

test('production Caido transport accepts only an unauthenticated loopback proxy', () => {
  const credentials = {} as any;
  assert.throws(() => new ProductionCaidoTransport('https://127.0.0.1:8181', credentials), /loopback HTTP origin/);
  assert.throws(() => new ProductionCaidoTransport('http://example.test:8181', credentials), /loopback HTTP origin/);
  assert.throws(() => new ProductionCaidoTransport('http://user:secret@127.0.0.1:8181', credentials), /loopback HTTP origin/);
  assert.doesNotThrow(() => new ProductionCaidoTransport('http://127.0.0.1:8181', credentials));
});

test('dedicated worker is Linux-only and ordinary worker remains bounty-isolation free', () => {
  const root=resolve(process.cwd(),'..');
  const dedicated=readFileSync(resolve(root,'backend/src/bounty-worker.ts'),'utf8');
  const ordinary=readFileSync(resolve(root,'backend/src/worker.ts'),'utf8');
  assert.match(dedicated,/process\.platform!=='linux'/);
  assert.match(dedicated,/registerIsolatedBountyProposalLane/);
  assert.match(dedicated,/No exact durable bounty runtime assignment/);
  assert.doesNotMatch(ordinary,/registerIsolatedBountyProposalLane|bounty-production-caido|DurableBountyCredentialBroker/);
});

test('production integration migration keeps credentials opaque and project traffic lineage durable', () => {
  const sql=readFileSync(resolve(process.cwd(),'src/db/pg-migrations/20260803220000_bounty_production_integrations.sql'),'utf8');
  assert.match(sql,/encrypted_material TEXT NOT NULL/);
  assert.match(sql,/handle_hash TEXT UNIQUE NOT NULL/);
  assert.match(sql,/bounty_caido_transactions/);
  assert.doesNotMatch(sql,/password TEXT|token TEXT|cookies TEXT/);
});
