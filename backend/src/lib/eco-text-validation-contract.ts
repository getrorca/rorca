/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Declarative host-only text checks. No shell, eval, plugins or model-authored observations. */
import {z} from 'zod';
export const HOST_TEXT_VALIDATOR = 'rorca:host-text-artifact:v1';
export const TextArtifactCheckSchema=z.object({
 expectedSha256:z.string().regex(/^sha256:[0-9a-f]{64}$/),
 requiredContent:z.array(z.string().min(1).max(4096)).min(1).max(100),
 minimumBytes:z.number().int().positive().max(10485760),
}).strict();
export const HostTextCheckSchema=TextArtifactCheckSchema.extend({
 deliverableId:z.string().min(1),relativePath:z.string().min(1),mediaType:z.string().startsWith('text/'),maximumBytes:z.number().int().positive().max(10485760),
}).strict();
export type HostTextCheck=z.infer<typeof HostTextCheckSchema>;
/** Fixed trusted host program. Proposal bytes enter stdin as JSON data, never
 * source/argv code; no filesystem, process, network or third-party imports. */
export const HOST_TEXT_CHECK_PROGRAM=String.raw`
const crypto=require('node:crypto');let input='';
process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{input+=c;if(Buffer.byteLength(input)>22000000)process.exit(1)});
process.stdin.on('end',()=>{try{
 const {check,text}=JSON.parse(input);if(typeof text!=='string')throw Error('Text artifact content is missing');
 const bytes=Buffer.from(text,'utf8'),artifactHash='sha256:'+crypto.createHash('sha256').update(bytes).digest('hex');
 if(bytes.toString('utf8')!==text||bytes.length<check.minimumBytes||bytes.length>check.maximumBytes)throw Error('Text artifact UTF-8/byte bounds failed');
 if(check.requiredContent.some(part=>!text.includes(part)))throw Error('Text artifact required content missing');
 if(artifactHash!==check.expectedSha256)throw Error('Text artifact SHA-256 mismatch');
 process.stdout.write(JSON.stringify({artifactHash,byteLength:bytes.length,deliverableId:check.deliverableId,relativePath:check.relativePath,checks:['lossless-utf8','byte-bounds','required-content','sha256'],codeExecution:'not-performed',validatorProcessPid:process.pid}));
}catch(e){process.stderr.write(e.message);process.exitCode=1}});`;
