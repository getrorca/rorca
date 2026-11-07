/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createEcoOpenAiMiniTokenizer} from '../eco-structured-worker';
import {createEcoModelBudgetBroker,type EcoModelReservation} from '../eco-model-budget';

/** Requires the explicitly installed pinned optional package. No skip/fallback
 * to byte/character counting. Qualification here is local protocol only. */
test('pinned js-tiktoken o200k implementation: Unicode, special-looking text and chat framing',()=>{
 const tokenizer=createEcoOpenAiMiniTokenizer({qualificationRef:'eco23:synthetic-local-protocol-only',scope:'local-fixture',packageVersion:'1.0.21',framing:'openai-chat-2024-v1'});
 assert.equal(tokenizer.scope,'local-fixture');
 for(const text of ['hello','你好','🙂'])assert.equal(tokenizer.countOutput(text),1);
 assert.equal(tokenizer.countOutput('<|endoftext|>'),7,'untrusted special-looking strings remain ordinary text');
 assert.notEqual(tokenizer.countOutput('你好'),Buffer.byteLength('你好'),'bytes are not model tokens');
 assert.equal(tokenizer.countInput([{role:'user',content:'你好'}]),8);
 assert.throws(()=>createEcoOpenAiMiniTokenizer({qualificationRef:'fixture',scope:'local-fixture',packageVersion:'wrong' as any,framing:'openai-chat-2024-v1'}),/unsupported/);
});

test('actual pinned tokenizer drives the real broker against explicitly synthetic loopback SSE',async t=>{
 const tokenizer=createEcoOpenAiMiniTokenizer({qualificationRef:'eco23:synthetic-local-protocol-only',scope:'local-fixture',packageVersion:'1.0.21',framing:'openai-chat-2024-v1'});
 let sends=0,reserved:Readonly<EcoModelReservation>|undefined;
 const server=createServer(async(req,res)=>{
  sends++;for await(const _ of req){};
  assert.ok(reserved,'reservation acknowledged before transport');
  res.writeHead(200,{'content-type':'text/event-stream'});
  const event={id:'explicit-synthetic-fixture',object:'chat.completion.chunk',created:1,model:tokenizer.model,choices:[{index:0,delta:{content:'你好🙂'},finish_reason:'stop'}]};
  res.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const port=(server.address() as {port:number}).port;
 const broker=createEcoModelBudgetBroker({mode:'local-fixture',provider:'openai',model:tokenizer.model,endpoint:`http://127.0.0.1:${port}/v1/chat/completions`,rootId:'explicit-fixture',attemptId:'explicit-fixture',authorityHash:`sha256:${createHash('sha256').update('fixture-not-a-host-receipt').digest('hex')}`,tokenizer,
  pricing:{scope:'local-fixture',qualificationRef:'eco23:synthetic-price-ceiling-not-provider-pricing',inputMicroUsdPerMillion:1,outputMicroUsdPerMillion:1,requestMicroUsd:1},
  limits:{maxInputTokens:100,maxOutputTokens:10,maxRequestBytes:2000,maxResponseBytes:2000,maxTotalTokens:110,maxTotalSpendMicroUsd:10,maxTotalResponseBytes:2000,maxRequests:1,timeoutMs:1000,deadlineAt:Date.now()+3000},
  reserve:async r=>{reserved=r;}});
 try{
  const result=await broker.complete({messages:[{role:'user',content:'你好'}],maxOutputTokens:10,stream:true});
  assert.equal(result.text,'你好🙂');assert.equal(result.outputTokens,2);assert.equal(result.inputTokens,8);
  assert.equal(reserved!.contextTokens,18);assert.equal(sends,1);
 }finally{await broker.stop();}
});
