/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Isolated integration fixture, NOT a model or production worker bootstrap.
 * Explicit IPC topology + invocation nonce are verified before runtime import.
 * Never import db/index, config, server or worker here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Client} from 'pg';

process.once('message',async (message:any)=>{
 let client:Client|undefined;
 try {
  const {config,nonce,dataDirectory,ownerPid,runId,payload}=message;
  assert.equal(typeof nonce,'string');assert.match(nonce,/^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(ownerPid)&&ownerPid>0);process.kill(ownerPid,0);
  const scratch=fs.realpathSync(path.join(os.homedir(),'.hermes/cache/scratch'));
  const root=fs.realpathSync(config.host);
  assert.ok(root.startsWith(scratch+path.sep+'eco16-pg-'));
  assert.equal(fs.realpathSync(dataDirectory),path.join(root,'data'));
  assert.equal(config.database,'postgres');assert.equal(config.user,'eco16_test');assert.equal(config.port,55496);
  const leasePath=path.join(root,'eco18-owner.lease');const leaseStat=fs.lstatSync(leasePath);
  assert.equal(leaseStat.isSymbolicLink(),false);assert.equal(leaseStat.uid,process.getuid!());assert.equal(leaseStat.mode&0o077,0);
  assert.deepEqual(JSON.parse(fs.readFileSync(leasePath,'utf8')),{nonce,ownerPid,dataDirectory,config});
  const postmaster=fs.readFileSync(path.join(dataDirectory,'postmaster.pid'),'utf8').split('\n');
  assert.equal(postmaster[1],dataDirectory);assert.equal(Number(postmaster[3]),55496);assert.equal(postmaster[4],root);
  process.kill(Number(postmaster[0]),0);
  // Exact options only: no URL, ambient PG values or untrusted spread.
  client=new Client({host:root,port:55496,database:'postgres',user:'eco16_test',options:'-c search_path=rorca,public',connectionTimeoutMillis:3000});
  await client.connect();
  const actual=(await client.query(`SELECT nonce,owner_pid,data_directory,postmaster_started_at FROM eco18_invocation`)).rows;
  assert.equal(actual.length,1);assert.equal(actual[0].nonce,nonce);assert.equal(Number(actual[0].owner_pid),ownerPid);
  assert.equal(actual[0].data_directory,dataDirectory);
  assert.equal((await client.query('SHOW data_directory')).rows[0].data_directory,dataDirectory);
  assert.equal(new Date((await client.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started).toISOString(),new Date(actual[0].postmaster_started_at).toISOString());
  process.send?.({type:'owned-db-verified'});
  const {executeEcoManagedWorker,ECO_PREPARED_PROTOCOL}=await import('../../eco-managed-runtime');
  const transaction=async <T>(action:(c:Client)=>Promise<T>)=>{await client!.query('BEGIN');try{const result=await action(client!);await client!.query('COMMIT');return result;}catch(error){await client!.query('ROLLBACK');throw error;}};
  // Polling needs a separate connection while the effect transaction is open.
  // Separate Clients are invocation-verified copies of the exact same topology.
  const transactionConcurrent=async <T>(action:(c:Client)=>Promise<T>)=>{
   const c=new Client({host:root,port:55496,database:'postgres',user:'eco16_test',options:'-c search_path=rorca,public',connectionTimeoutMillis:3000});
   await c.connect();try{await c.query('BEGIN');const result=await action(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}finally{await c.end();}
  };
  let child:ReturnType<typeof spawn>|undefined;let death:Promise<unknown>|undefined;let stopped=false;let aborted=false;let closed=0;
  const executor:import('../../eco-managed-runtime').EcoBoundedExecutor={protocol:ECO_PREPARED_PROTOCOL,
   steps:async()=>[{id:'explicit-harmless-simulator',usage:{toolCalls:1,contextTokens:0,outputBytes:64,spendMicroUsd:0}}],
   perform:async(_id:string,signal:AbortSignal)=>{
    // No shell, file write, network, model, credential or production command.
    child=spawn(process.execPath,['-e','process.stdout.write("simulator-ready\\n");setInterval(()=>{},1000)'],{env:{},stdio:['ignore','pipe','pipe']});
    death=once(child,'close');await once(child.stdout!,'data');
    process.send?.({type:'effect-started',pid:child.pid});
    await new Promise<void>((resolve,reject)=>{
     const timeout=setTimeout(()=>reject(Error('fixture did not observe mid-effect lease loss')),1800);
     signal.addEventListener('abort',()=>{clearTimeout(timeout);aborted=true;resolve();},{once:true});
     if(signal.aborted){clearTimeout(timeout);aborted=true;resolve();}
    });
   },
   stop:async()=>{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');if(death)await death;stopped=true;}
  };
  try {
   await assert.rejects(executeEcoManagedWorker({runId,payload,transaction:transactionConcurrent,worker:{ownerId:'fixture-worker'},executor,closeout:async()=>{closed++;}}),/authority lost/i);
   assert.equal(aborted,true);assert.equal(stopped,true);assert.equal(closed,0);
   assert.ok(child?.pid);assert.throws(()=>process.kill(child!.pid!,0),{code:'ESRCH'});
   const usage=(await transaction(c=>c.query('SELECT event_key FROM eco_managed_usage_events WHERE run_id=$1',[runId]))).rows;
   assert.equal(usage.length,2); // worker-start + one nonrefundable pre-effect reservation
   process.send?.({type:'simulator-result',aborted,stopped,closed,usageEvents:usage.length});
  }finally{await executor.stop();}
  await client.end();client=undefined;process.disconnect?.();
 }catch(error){await client?.end().catch(()=>{});process.stderr.write(String(error instanceof Error?error.stack:error)+'\n');process.exitCode=1;process.disconnect?.();}
});
