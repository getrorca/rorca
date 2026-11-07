/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import http from 'node:http';
import tls from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import { queryOne, transaction } from '../db';
import { commitEffectSendFence, observeEffect, reconcileEffect } from './bounty-operation-ledger';
import { ForbiddenError, ValidationError } from './errors';
import type { CaidoBroker, CaidoDecision, CaidoTransport, EvidenceGateway, CaidoCorrelation } from './bounty-caido-adapter';
import type { DurableBountyCredentialBroker } from './bounty-durable-credential-broker';

const sha=(v:Uint8Array|string)=>`sha256:${createHash('sha256').update(v).digest('hex')}`;
interface OperationRow { workspace_id:string; mission_id:string; authority_epoch:string; state:string; expires_at:Date|string; payload:Record<string,unknown> }
export class ProductionCaidoBroker implements CaidoBroker {
  async authorize(input: Omit<CaidoDecision,'allowed'|'decisionId'|'expiresAt'> & CaidoCorrelation & {costCents:number}):Promise<CaidoDecision>{
    const row=await queryOne<OperationRow>(`SELECT workspace_id,mission_id,authority_epoch,state,expires_at,payload FROM bounty_operations WHERE id=$1 AND mission_id=$2 AND kind='target.effect'`,[input.operationId,input.missionId]);
    if(!row||row.state!=='prepared'||Number(row.authority_epoch)!==input.epoch||Date.parse(String(row.expires_at))<=Date.now()) throw new ForbiddenError('Caido operation lacks fresh prepared authority');
    const payload=row.payload; if(payload.canonicalDestination!==input.canonicalDestination||payload.action!==input.action||payload.credentialRole!==input.credentialRole) throw new ForbiddenError('Caido request differs from prepared effect');
    await commitEffectSendFence(input.operationId,input.epoch);
    return {allowed:true,decisionId:randomUUID(),canonicalDestination:input.canonicalDestination,action:input.action,credentialRole:input.credentialRole,credentialHandle:input.credentialHandle,method:input.method??'GET',epoch:input.epoch,expiresAt:new Date(Math.min(Date.parse(String(row.expires_at)),Date.now()+30_000)).toISOString()};
  }
}

export class ProductionCaidoTransport implements CaidoTransport {
  constructor(private readonly proxyOrigin:string,private readonly credentials:DurableBountyCredentialBroker,private readonly rejectUnauthorized=true,private readonly maxBytes=10_000_000){const u=new URL(proxyOrigin);if(u.protocol!=='http:'||!['127.0.0.1','::1','localhost'].includes(u.hostname)||u.username||u.password||u.pathname!=='/')throw new ValidationError('Caido proxy must be an unauthenticated loopback HTTP origin');}
  async forward(input:{decision:CaidoDecision;correlation:CaidoCorrelation;body?:Uint8Array}):Promise<{transactionId:string;bytes:Uint8Array}>{
    const destination=new URL(input.decision.canonicalDestination); if(!['https:','http:'].includes(destination.protocol))throw new ForbiddenError('Caido transport destination protocol denied');
    const material=input.decision.credentialHandle?await this.credentials.redeem(input.decision.credentialHandle,{adapter:'http-trusted',origin:destination.origin,action:input.decision.action,epoch:input.decision.epoch}):{};
    const headers:Record<string,string>={host:destination.host,connection:'close','x-rorca-operation-id':input.correlation.operationId};
    if(material.token)headers.authorization=`Bearer ${material.token}`; else if(material.username&&material.password)headers.authorization=`Basic ${Buffer.from(`${material.username}:${material.password}`).toString('base64')}`; if(material.cookies)headers.cookie=material.cookies;
    const socket=await this.connect(destination); try { const body=input.body??new Uint8Array(); if(body.byteLength)headers['content-length']=String(body.byteLength); const head=[`${input.decision.method??'GET'} ${destination.pathname}${destination.search} HTTP/1.1`,...Object.entries(headers).map(([k,v])=>`${k}: ${v}`),'',''].join('\r\n'); socket.write(head); if(body.byteLength)socket.write(body); const bytes=await this.readBounded(socket); return{transactionId:randomUUID(),bytes}; } finally {socket.destroy();}
  }
  private connect(destination:URL):Promise<tls.TLSSocket|import('node:net').Socket>{return new Promise((resolve,reject)=>{const proxy=new URL(this.proxyOrigin);const request=http.request({host:proxy.hostname,port:Number(proxy.port||80),method:'CONNECT',path:`${destination.hostname}:${destination.port|| (destination.protocol==='https:'?443:80)}`,headers:{'x-rorca-transport':'governed-caido-v1'}});request.once('connect',(_res,socket,head)=>{if(head.length)socket.unshift(head);if(destination.protocol==='https:'){const secure=tls.connect({socket,servername:destination.hostname,rejectUnauthorized:this.rejectUnauthorized},()=>resolve(secure));secure.once('error',reject);}else resolve(socket);});request.once('error',reject);request.end();});}
  private readBounded(socket:NodeJS.ReadableStream):Promise<Uint8Array>{return new Promise((resolve,reject)=>{const chunks:Buffer[]=[];let size=0;socket.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>this.maxBytes){reject(new ForbiddenError('Caido response exceeds evidence limit'));return;}chunks.push(chunk);});socket.once('end',()=>resolve(Buffer.concat(chunks)));socket.once('error',reject);});}
}

export class ProductionCaidoEvidenceGateway implements EvidenceGateway {
  async admit(input:{transactionId:string;websocketTransactionId?:string;correlation:CaidoCorrelation;bytes:Uint8Array}):Promise<{evidenceId:string}>{const evidenceId=randomUUID();try{await transaction(async client=>{const op=await client.query<OperationRow>('SELECT workspace_id,mission_id,authority_epoch,state,expires_at,payload FROM bounty_operations WHERE id=$1 FOR SHARE',[input.correlation.operationId]);const row=op.rows[0];if(!row||row.state!=='sent')throw new ForbiddenError('Evidence has no sent operation lineage');await client.query(`INSERT INTO bounty_evidence(id,workspace_id,mission_id,evidence_identity,digest,payload,authority_epoch) VALUES($1,$2,$3,$4,$5,$6,$7)`,[evidenceId,row.workspace_id,row.mission_id,`caido:${input.transactionId}`,sha(input.bytes),{transactionId:input.transactionId,correlation:input.correlation,byteLength:input.bytes.byteLength},Number(row.authority_epoch)]);await client.query(`INSERT INTO bounty_caido_transactions(id,workspace_id,mission_id,operation_id,decision_id,caido_project_id,request_hash,response_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'observed')`,[input.transactionId,row.workspace_id,row.mission_id,input.correlation.operationId,input.correlation.operationId,String(row.payload.caidoProjectId??''),sha(JSON.stringify(row.payload)),sha(input.bytes)]);});const operation=await queryOne<{authority_epoch:string}>('SELECT authority_epoch FROM bounty_operations WHERE id=$1',[input.correlation.operationId]);if(!operation)throw new ForbiddenError('Evidence operation disappeared');await observeEffect(input.correlation.operationId,Number(operation.authority_epoch));return{evidenceId};}catch(error){await reconcileEffect(input.correlation.operationId,'unknown').catch(()=>undefined);throw error;}}
}
