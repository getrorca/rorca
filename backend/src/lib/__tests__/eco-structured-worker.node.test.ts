/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {createEcoTypedToolGateway,createEcoStructuredExecutor,createEcoOpenAiMiniTokenizer} from '../eco-structured-worker';
import {body} from './fixtures/eco-phase-work.fixture';

test('production route refuses arbitrary exact-tokenizer claims and missing qualification without IO',()=>{
 assert.throws(()=>createEcoOpenAiMiniTokenizer(''),/qualification/);
 const scope:any={binding:{phaseWork:body()}};
 assert.throws(()=>createEcoStructuredExecutor(scope,{mode:'production',model:'gpt-4o-mini-2024-07-18',endpoint:'https://api.openai.com/v1/chat/completions',authorization:'fixture-not-a-credential',
  tokenizer:{id:'o200k_base:openai-chat-2024-v1',scope:'production',qualificationRef:'caller-claim',provider:'openai',model:'gpt-4o-mini-2024-07-18',protocol:'openai-chat-text-v1',kind:'exact',countInput:()=>0,countOutput:()=>0},
  pricing:{scope:'production',qualificationRef:'caller-price',inputMicroUsdPerMillion:1,outputMicroUsdPerMillion:1,requestMicroUsd:0},limits:{} as any,sources:{}}),/configuration missing or unsupported/);
});

test('harmless child: real OS network denial and typed host refusal of fetch/exec (no model process exists)',async()=>{
 const policy=process.platform==='darwin'?'/usr/bin/sandbox-exec':undefined;
 // This repository supports Darwin qualification here. Absence is an explicit
 // failing requirement, never a skipped containment claim.
 assert.ok(policy,'this real containment fixture requires Darwin sandbox-exec');
 let connections=0;
 const server=createServer(socket=>{connections++;socket.destroy();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=(server.address() as {port:number}).port;
 try {
  const code=`const net=require('node:net');const s=net.connect({host:'127.0.0.1',port:${port}});s.on('connect',()=>process.exit(9));s.on('error',e=>{process.stdout.write(JSON.stringify({denied:e.code,tools:[{tool:'fetch',url:'http://127.0.0.1:${port}/'},{tool:'exec',command:'true'}]}));});setTimeout(()=>process.exit(8),1000).unref();`;
  const child=spawn(policy,['-p','(version 1)(allow default)(deny network*)',process.execPath,'-e',code],{env:{},stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const [status]=await once(child,'close');assert.equal(status,0,err);
  const result=JSON.parse(out);assert.ok(['EPERM','EACCES'].includes(result.denied),out);assert.equal(connections,0);
  let effects=0;
  const gateway=createEcoTypedToolGateway({binding:{phaseWork:body()}} as any,{}, {runId:1,reserveModel:async()=>{effects++;},reserveTool:async()=>{effects++;},storeArtifact:async()=>{effects++;}});
  for(const tool of result.tools)await assert.rejects(gateway.invoke(tool,new AbortController().signal));
  assert.equal(effects,0);
 }finally{server.close();await once(server,'close');}
});
