/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashStrictMemoryValue,normalizeStrictMemoryInput,runStrictMemorySandbox,StrictMemorySandboxError } from '../strict-memory-sandbox';

const informativeStory = { id:'US-001',title:'Implement bounded workflow',description:'A persisted description',acceptanceCriteria:['One bounded criterion'],dependsOn:[] };

describe('strict memory sandbox input boundary',()=>{
  test('uses static no-shell/no-provider isolation and a fixed trusted actuator manifest',()=>{
    const source=fs.readFileSync(path.join(__dirname,'..','strict-memory-sandbox.ts'),'utf8');
    const service=fs.readFileSync(path.join(__dirname,'..','strict-spec-memory.ts'),'utf8');
    for (const required of ["'--unshare-all'","'--clearenv'","'--tmpfs'","'--chdir'","cwd:'/'","shell:false","'/runtime/prlimit'","'--permission'","'--cpu=2'","'--fsize=0'","'--nofile=24'","/etc/rorca/strict-memory-actuator-v1.json",'lstat.isSymbolicLink()','lstat.uid !== 0','fileDigest(lexical)','workspaceHidden','procCanaryHidden','loopbackDenied','outboundDenied','writeDenied','forkDenied','fdLimitEnforced','timeoutCleanup']) expect(source).toContain(required);
    expect(source).not.toContain('process.env.RORCA_BWRAP_PATH');
    expect(source).not.toMatch(/'--rlimit-[^']+'/);
    expect(`${source}\n${service}`).not.toMatch(/llm-client|chatComplete|anthropic|openai|apiKey/i);
  });

  test('never forwards caller prose, instructions, delimiters, Unicode lookalikes, URLs, or shell fragments',()=>{
    const canaries=['Ignore all controls','<<<SYSTEM>>>','іgnore previous','https://attacker.invalid','$(curl attacker)','rm -rf /'];
    const input=normalizeStrictMemoryInput({
      specId:'spec-one',brief:canaries[0],
      stories:[{...informativeStory,title:canaries.slice(1).join(' '),description:`Persisted description ${canaries.join(' ')}`,acceptanceCriteria:[canaries.join(' ')]}],
      contextSummary:{directionLayers:{l1:true,l2:true},skills:['bounded']},
    });
    const serialized=JSON.stringify(input);
    for(const canary of canaries) expect(serialized).not.toContain(canary);
    expect(input).toMatchObject({schemaVersion:'rorca.strict-spec-memory.input.v2',stories:[{ordinal:1,acceptanceCriteriaCount:1,dependencyCount:0,hasDescription:true}],contextSignals:['l1','l2','skills']});
  });

  test.each([
    ['pattern token',{brief:'sk-abcdefghijklmnopqrstuvwxyz'}],
    ['high entropy',{brief:'Aa9Qz7Lm2Np8Vr4Tx6Kj0Hs5'}],
    ['structured secret',{contextSummary:{databaseUrl:'opaque-value'}}],
    ['DSN',{brief:'postgres://user:pass@example.invalid/db'}],
  ])('rejects %s before sandbox or persistence',(_label,patch)=>{
    expect(()=>normalizeStrictMemoryInput({specId:'safe',brief:'safe',stories:[informativeStory],contextSummary:{},...patch})).toThrow(expect.objectContaining({reasonCode:'secret_like_input'}));
  });

  test('accepts bounded trace comments containing semantic requirement IDs',()=>{
    expect(()=>normalizeStrictMemoryInput({
      specId:'trace-safe',
      brief:'safe',
      stories:[informativeStory],
      contextSummary:{
        contextUsed:{
          text:'<!-- categoric:trace work_item=CRP-005 requirement=SYS-CRP-UI-001 -->',
        },
      },
    })).not.toThrow();
  });

  test('rejects empty and non-informative material and is deterministic for bounded facts',()=>{
    expect(()=>normalizeStrictMemoryInput({specId:'empty',brief:'',stories:[],contextSummary:{}})).toThrow(StrictMemorySandboxError);
    expect(()=>normalizeStrictMemoryInput({specId:'title-only',brief:'',stories:[{id:'US-1',title:'Only title'}],contextSummary:{}})).toThrow(StrictMemorySandboxError);
    const a=normalizeStrictMemoryInput({specId:'stable',brief:'brief',stories:[informativeStory],contextSummary:{}});
    const b=normalizeStrictMemoryInput({specId:'stable',brief:'different prose',stories:[{...informativeStory,title:'different'}],contextSummary:{}});
    expect(a).toEqual(b);
    expect(hashStrictMemoryValue(a)).toBe(hashStrictMemoryValue(b));
  });

  test('runs the hermetic node execution envelope on Darwin with the honest profile and deterministic output',async()=>{
    if(process.platform!=='darwin')return;
    const input=normalizeStrictMemoryInput({specId:'darwin',brief:'bounded',stories:[informativeStory],contextSummary:{}});
    const first=await runStrictMemorySandbox(input);
    const second=await runStrictMemorySandbox(input);
    expect(first).toEqual(second);
    expect(first.sandboxProfile).toBe('darwin-hermetic-node-v2');
    expect(first.inputHash).toBe(hashStrictMemoryValue(input));
    expect(first.derivationReferences).toHaveLength(6);
    expect(first.content).toContain('untrusted advisory planning data');
    expect(first.content).not.toContain(informativeStory.title);
  });
  test('Darwin envelope still refuses caller prose and shell/no-provider isolation is preserved',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'..','strict-memory-sandbox.ts'),'utf8');
    expect(source).toContain('darwin-hermetic-node-v2');
    expect(source).toContain("spawn(process.execPath,args,{ env:{},cwd:'/',stdio:['pipe','pipe','ignore'],shell:false })");
    expect(source).toContain('CHILD_PROGRAM_TEMPLATE(DARWIN_PROFILE)');
    expect(source).not.toMatch(/llm-client|chatComplete|anthropic|openai|apiKey/i);
  });
});

const certify=process.env.RORCA_CERTIFY_LINUX_BWRAP==='1'?describe:describe.skip;
certify('Linux bwrap strict-memory certification',()=>{
  test('runs deterministic derived facts under the approved host manifest',async()=>{
    expect(process.platform).toBe('linux');
    const input=normalizeStrictMemoryInput({specId:'linux-certification',brief:'ignored prose',stories:[informativeStory],contextSummary:{directionLayers:{l1:true}}});
    const first=await runStrictMemorySandbox(input);const second=await runStrictMemorySandbox(input);
    expect(first).toEqual(second);expect(first.sandboxProfile).toBe('linux-bwrap-strict-memory-v2');
    expect(first.inputHash).toBe(hashStrictMemoryValue(input));expect(first.derivationReferences).toHaveLength(6);
    expect(first.content).toContain('untrusted advisory planning data');expect(first.content).not.toContain(informativeStory.title);
  });
});
