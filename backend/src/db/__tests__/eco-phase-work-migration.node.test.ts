/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

test('additive phase binding migration has scoped identity, immutable history and no execution grants',()=>{
 const sql=fs.readFileSync(path.resolve(__dirname,'../pg-migrations/20261027120000_eco_phase_work_binding.sql'),'utf8');
 assert.match(sql,/CREATE TABLE.*eco_phase_work_revisions/);
 assert.match(sql,/UNIQUE\s*\(workspace_id,\s*phase_work_id,\s*revision\)/);
 assert.match(sql,/FOREIGN KEY\s*\(claim_id,\s*workspace_id\)/);
 assert.match(sql,/BEFORE UPDATE OR DELETE/);
 assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
 assert.doesNotMatch(sql,/GRANT[^;]*(UPDATE|DELETE|TRUNCATE)[^;]*TO/i);
});
