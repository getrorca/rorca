/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareGoldenTestRepository} from './eco-golden-test-fixture';
import {ensureWorktreeRuntimeSupport} from '../src/lib/worktree-runtime';
import {compileSpecExportKit,publishSpecExportKit,sealSpecExportKit,assertSealedSpecExportKit} from '../src/lib/spec-export-kit';
// Pure producer/validator fixture test. No db/index or ambient DB bootstrap.
test('TEST ignore policy is committed before source sealing; native setup stays clean without hiding output',()=>{
 const root=fs.mkdtempSync(path.join(os.homedir(),'.hermes/cache/scratch/eco27-ignore-test-'));
 const git=(args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
 try{
  const revision=prepareGoldenTestRepository(root);
  assert.equal(git(['show',`${revision}:.gitignore`]),fs.readFileSync(path.join(root,'.gitignore'),'utf8').trim());
  assert.equal(ensureWorktreeRuntimeSupport(root,root).gitignoreUpdated,false);
  assert.equal(git(['status','--porcelain','--untracked-files=all']),'');
  fs.writeFileSync(path.join(root,'meaningful.txt'),'must remain dirty');
  assert.match(git(['status','--porcelain','--untracked-files=all']),/\?\? meaningful.txt/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('TEST source must use compiler publication and immutable native seal',()=>{
 const root=fs.mkdtempSync(path.join(os.homedir(),'.hermes/cache/scratch/eco24-kit-test-'));
 const source:any={id:'TEST-parent',title:'TEST text proposal',userStories:[{id:'US-1',title:'Proposal',acceptanceCriteria:['Review'],passes:false}]};
 try{
  assert.throws(()=>assertSealedSpecExportKit(root,source),/missing/);
  source.exportKitIdentity=publishSpecExportKit(root,source);
  assert.deepEqual(source.exportKitIdentity,compileSpecExportKit(source).identity);
  assert.throws(()=>assertSealedSpecExportKit(root,source),/not sealed/);
  sealSpecExportKit(root,source,{actorId:'TEST-eco24-fixture-approver',approvalReceiptId:'TEST-eco24-source-seal'});
  assert.deepEqual(assertSealedSpecExportKit(root,source),source.exportKitIdentity);
  source.title='changed';assert.throws(()=>assertSealedSpecExportKit(root,source),/stale/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
