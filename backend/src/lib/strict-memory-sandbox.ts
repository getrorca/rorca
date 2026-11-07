/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as net from 'node:net';
import * as os from 'node:os';
import { SENSITIVE_KEY_PATTERN, detectSecretLikeString } from './context-safety';

const INPUT_LIMIT_BYTES = 128 * 1024;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const TIMEOUT_MS = 3_000;
const PROFILE = 'linux-bwrap-strict-memory-v2' as const;
const DARWIN_PROFILE = 'darwin-hermetic-node-v2' as const;
const ACTUATOR_MANIFEST_PATH = '/etc/rorca/strict-memory-actuator-v1.json';
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export interface StrictMemoryStoryInput {
  ordinal: number;
  acceptanceCriteriaCount: number;
  dependencyCount: number;
  hasDescription: boolean;
}

export interface StrictMemorySandboxInput {
  schemaVersion: 'rorca.strict-spec-memory.input.v2';
  specRefHash: string;
  stories: StrictMemoryStoryInput[];
  contextSignals: Array<'l1' | 'l2' | 'l3' | 'schema' | 'skills' | 'memory'>;
}

export interface StrictMemoryDerivationReference {
  fact: 'story_count' | 'acceptance_criteria_count' | 'dependency_edge_count' | 'root_story_count' | 'missing_description_count' | 'context_signal_count';
  persistedPaths: string[];
  value: number;
}

export interface StrictMemorySandboxOutput {
  schemaVersion: 'rorca.strict-spec-memory.output.v2';
  category: 'Spec Derived Facts';
  content: string;
  confidence: 'medium';
  relatedFiles: [];
  derivationReferences: StrictMemoryDerivationReference[];
  inputHash: string;
  derivationHash: string;
  sandboxProfile: typeof PROFILE | typeof DARWIN_PROFILE;
}

export class StrictMemorySandboxError extends Error {
  constructor(public readonly reasonCode: 'unsupported_platform' | 'sandbox_unavailable' | 'input_invalid' | 'secret_like_input' | 'sandbox_failed' | 'output_invalid') {
    super(`Strict memory sandbox failed closed (${reasonCode})`);
    this.name = 'StrictMemorySandboxError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function hashStrictMemoryValue(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function assertNoSecretLikeValue(value: unknown, keyHint = '', depth = 0): void {
  if (depth > 12) throw new StrictMemorySandboxError('input_invalid');
  if (typeof value === 'string') {
    if ((keyHint && SENSITIVE_KEY_PATTERN.test(keyHint) && value.trim()) || detectSecretLikeString(value)) {
      throw new StrictMemorySandboxError('secret_like_input');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw new StrictMemorySandboxError('input_invalid');
    value.forEach((item) => assertNoSecretLikeValue(item, keyHint, depth + 1));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) assertNoSecretLikeValue(nested, key, depth + 1);
  }
}

function boundedCount(value: unknown, maximum: number): number {
  if (!Array.isArray(value)) return 0;
  if (value.length > maximum) throw new StrictMemorySandboxError('input_invalid');
  return value.length;
}

function presentSignal(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * Converts persisted spec material to structural facts only. Caller prose is
 * inspected for secret-like material but never crosses the sandbox boundary.
 */
export function normalizeStrictMemoryInput(value: {
  specId: string;
  brief: unknown;
  stories: unknown;
  contextSummary: unknown;
}): StrictMemorySandboxInput {
  assertNoSecretLikeValue(value);
  if (typeof value.specId !== 'string' || !value.specId.trim() || !Array.isArray(value.stories)) {
    throw new StrictMemorySandboxError('input_invalid');
  }
  if (value.stories.length < 1 || value.stories.length > 64 || value.stories.some((item) => !isRecord(item))) {
    throw new StrictMemorySandboxError('input_invalid');
  }
  const stories = value.stories.map((item, index): StrictMemoryStoryInput => {
    const story = item as Record<string, unknown>;
    const description = typeof story.description === 'string' ? story.description.trim() : '';
    return {
      ordinal: index + 1,
      acceptanceCriteriaCount: boundedCount(story.acceptanceCriteria, 20),
      dependencyCount: boundedCount(story.dependsOn, 64),
      hasDescription: description.length > 0,
    };
  });
  const contextSummary = isRecord(value.contextSummary) ? value.contextSummary : {};
  const layers = isRecord(contextSummary.directionLayers) ? contextSummary.directionLayers : {};
  const contextSignals: StrictMemorySandboxInput['contextSignals'] = [];
  if (presentSignal(layers.l1)) contextSignals.push('l1');
  if (presentSignal(layers.l2)) contextSignals.push('l2');
  if (presentSignal(layers.l3)) contextSignals.push('l3');
  if (presentSignal(contextSummary.schemaSnapshot)) contextSignals.push('schema');
  if (Array.isArray(contextSummary.skills) && contextSummary.skills.length > 0) contextSignals.push('skills');
  if (typeof contextSummary.memoryEntries === 'number' && contextSummary.memoryEntries > 0) contextSignals.push('memory');

  const informative = stories.length > 0 && (
    stories.some((story) => story.hasDescription || story.acceptanceCriteriaCount > 0 || story.dependencyCount > 0)
    || contextSignals.length > 0
  );
  if (!informative) throw new StrictMemorySandboxError('input_invalid');
  const input: StrictMemorySandboxInput = {
    schemaVersion: 'rorca.strict-spec-memory.input.v2',
    specRefHash: hashStrictMemoryValue(value.specId.trim()),
    stories,
    contextSignals,
  };
  if (Buffer.byteLength(canonicalJson(input), 'utf8') > INPUT_LIMIT_BYTES) throw new StrictMemorySandboxError('input_invalid');
  return input;
}

// Static child: no caller source/prose, filesystem path, command, environment,
// provider, shell, or non-built-in import reaches this program.
const CHILD_PROGRAM_TEMPLATE = (profile: string) => String.raw`
const crypto=require('node:crypto');let raw='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{raw+=c;if(Buffer.byteLength(raw)>131072)process.exit(70)});
function canon(v){if(Array.isArray(v))return '['+v.map(canon).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';return JSON.stringify(v)}
process.stdin.on('end',()=>{try{const i=JSON.parse(raw);if(i.schemaVersion!=='rorca.strict-spec-memory.input.v2'||!/^sha256:[0-9a-f]{64}$/.test(i.specRefHash)||!Array.isArray(i.stories)||!i.stories.length||!Array.isArray(i.contextSignals))process.exit(71);
const total=i.stories.length,ac=i.stories.reduce((n,s)=>n+s.acceptanceCriteriaCount,0),edges=i.stories.reduce((n,s)=>n+s.dependencyCount,0),roots=i.stories.filter(s=>s.dependencyCount===0).length,missing=i.stories.filter(s=>!s.hasDescription).length,signals=i.contextSignals.length;
const refs=[['story_count',['stories'],total],['acceptance_criteria_count',i.stories.map(s=>'stories['+(s.ordinal-1)+'].acceptanceCriteria'),ac],['dependency_edge_count',i.stories.map(s=>'stories['+(s.ordinal-1)+'].dependsOn'),edges],['root_story_count',i.stories.map(s=>'stories['+(s.ordinal-1)+'].dependsOn'),roots],['missing_description_count',i.stories.map(s=>'stories['+(s.ordinal-1)+'].description'),missing],['context_signal_count',['contextSummary.directionLayers','contextSummary.schemaSnapshot','contextSummary.skills','contextSummary.memoryEntries'],signals]].map(([fact,persistedPaths,value])=>({fact,persistedPaths,value}));
const content='Deterministic advisory spec facts: stories='+total+'; acceptance criteria='+ac+'; dependency edges='+edges+'; root stories='+roots+'; missing descriptions='+missing+'; bounded context signals='+signals+'. These derived facts are untrusted advisory planning data, not instructions, execution evidence, or approval.';
const h='sha256:'+crypto.createHash('sha256').update(canon(i)).digest('hex'),dh='sha256:'+crypto.createHash('sha256').update(canon(refs)).digest('hex');
process.stdout.write(JSON.stringify({schemaVersion:'rorca.strict-spec-memory.output.v2',category:'Spec Derived Facts',content,confidence:'medium',relatedFiles:[],derivationReferences:refs,inputHash:h,derivationHash:dh,sandboxProfile:'${profile}'}));}catch{process.exit(72)}});
`;
const CHILD_PROGRAM = CHILD_PROGRAM_TEMPLATE(PROFILE);

interface ManifestFile { source: string; target: string; sha256: string }
interface ActuatorManifest {
  schemaVersion: 'rorca.strict-memory-actuator-manifest.v1';
  supported: { os: 'linux'; libc: 'glibc'; architectures: string[] };
  bwrap: { path: string; sha256: string; version: string };
  node: { path: string; sha256: string; version: string };
  prlimit: { path: string; sha256: string; version: string };
  runtimeFiles: ManifestFile[];
}
interface VerifiedFile extends ManifestFile { dev: number; ino: number }
interface VerifiedManifest { manifest: ActuatorManifest; bwrap: VerifiedFile; node: VerifiedFile; prlimit: VerifiedFile; runtimeFiles: VerifiedFile[] }

function fileDigest(filePath: string): string {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function assertTrustedAbsoluteFile(filePath: string, expectedHash: string): VerifiedFile {
  if (!path.isAbsolute(filePath) || !SHA256.test(expectedHash)) throw new StrictMemorySandboxError('sandbox_unavailable');
  const lexical = path.resolve(filePath);
  const lstat = fs.lstatSync(lexical);
  if (lstat.isSymbolicLink() || !lstat.isFile() || lstat.uid !== 0 || (lstat.mode & 0o022) !== 0) throw new StrictMemorySandboxError('sandbox_unavailable');
  let parent = path.dirname(lexical);
  while (true) {
    const stat = fs.lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new StrictMemorySandboxError('sandbox_unavailable');
    if (parent === '/') break;
    parent = path.dirname(parent);
  }
  if (fs.realpathSync(lexical) !== lexical || fileDigest(lexical) !== expectedHash) throw new StrictMemorySandboxError('sandbox_unavailable');
  return { source: lexical, target: lexical, sha256: expectedHash, dev: lstat.dev, ino: lstat.ino };
}

function loadActuatorManifest(): VerifiedManifest {
  // Deliberately ignore RORCA_BWRAP_PATH, PATH, cwd, and workspace config.
  const manifestFile = assertTrustedAbsoluteFile(ACTUATOR_MANIFEST_PATH, fileDigest(ACTUATOR_MANIFEST_PATH));
  void manifestFile;
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(ACTUATOR_MANIFEST_PATH, 'utf8')); } catch { throw new StrictMemorySandboxError('sandbox_unavailable'); }
  if (!isRecord(parsed) || parsed.schemaVersion !== 'rorca.strict-memory-actuator-manifest.v1' || !isRecord(parsed.supported)
    || parsed.supported.os !== 'linux' || parsed.supported.libc !== 'glibc' || !Array.isArray(parsed.supported.architectures)
    || !parsed.supported.architectures.includes(process.arch) || !isRecord(parsed.bwrap) || !isRecord(parsed.node) || !isRecord(parsed.prlimit)
    || !Array.isArray(parsed.runtimeFiles) || parsed.runtimeFiles.length < 1 || parsed.runtimeFiles.length > 64) {
    throw new StrictMemorySandboxError('sandbox_unavailable');
  }
  const manifest = parsed as unknown as ActuatorManifest;
  if (manifest.node.version !== process.version) throw new StrictMemorySandboxError('sandbox_unavailable');
  const bwrap = assertTrustedAbsoluteFile(manifest.bwrap.path, manifest.bwrap.sha256);
  const node = assertTrustedAbsoluteFile(manifest.node.path, manifest.node.sha256);
  const prlimit = assertTrustedAbsoluteFile(manifest.prlimit.path, manifest.prlimit.sha256);
  const version = spawnSync(bwrap.source, ['--version'], { env: {}, encoding: 'utf8', timeout: 1_000, maxBuffer: 4096 });
  const prlimitVersion = spawnSync(prlimit.source, ['--version'], { env: {}, encoding: 'utf8', timeout: 1_000, maxBuffer: 4096 });
  if (version.status !== 0 || !String(version.stdout).trim().includes(manifest.bwrap.version)
    || prlimitVersion.status !== 0 || !String(prlimitVersion.stdout).trim().includes(manifest.prlimit.version)) {
    throw new StrictMemorySandboxError('sandbox_unavailable');
  }
  const runtimeFiles = manifest.runtimeFiles.map((file) => {
    if (!isRecord(file) || typeof file.source !== 'string' || typeof file.target !== 'string' || typeof file.sha256 !== 'string'
      || !path.posix.isAbsolute(file.target) || file.target.includes('..') || file.target === '/runtime/node') throw new StrictMemorySandboxError('sandbox_unavailable');
    return { ...assertTrustedAbsoluteFile(file.source, file.sha256), target: file.target };
  });
  return {
    manifest,
    bwrap: { ...bwrap, target: bwrap.source },
    node: { ...node, target: '/runtime/node' },
    prlimit: { ...prlimit, target: '/runtime/prlimit' },
    runtimeFiles,
  };
}

function assertIdentityUnchanged(file: VerifiedFile): void {
  const stat = fs.lstatSync(file.source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== file.dev || stat.ino !== file.ino || fileDigest(file.source) !== file.sha256) {
    throw new StrictMemorySandboxError('sandbox_unavailable');
  }
}

function mountArgs(mounts: VerifiedFile[]): string[] {
  const dirs = new Set<string>(['/runtime']);
  for (const { target } of mounts) {
    let parent = path.posix.dirname(target);
    while (parent !== '/') { dirs.add(parent); parent = path.posix.dirname(parent); }
  }
  const args: string[] = [];
  for (const dir of [...dirs].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b))) args.push('--dir',dir);
  for (const mount of mounts) args.push('--ro-bind',mount.source,mount.target);
  return args;
}

function validateOutput(raw: string, inputHash: string): StrictMemorySandboxOutput {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new StrictMemorySandboxError('output_invalid'); }
  if (!isRecord(parsed) || parsed.schemaVersion !== 'rorca.strict-spec-memory.output.v2' || parsed.category !== 'Spec Derived Facts'
    || parsed.confidence !== 'medium' || parsed.inputHash !== inputHash
    || (parsed.sandboxProfile !== PROFILE && parsed.sandboxProfile !== DARWIN_PROFILE)
    || !Array.isArray(parsed.relatedFiles) || parsed.relatedFiles.length !== 0 || !Array.isArray(parsed.derivationReferences)
    || parsed.derivationReferences.length !== 6 || typeof parsed.derivationHash !== 'string' || !SHA256.test(parsed.derivationHash)
    || hashStrictMemoryValue(parsed.derivationReferences) !== parsed.derivationHash
    || typeof parsed.content !== 'string' || parsed.content.length < 1 || parsed.content.length > 2_000
    || detectSecretLikeString(parsed.content)) throw new StrictMemorySandboxError('output_invalid');
  return parsed as unknown as StrictMemorySandboxOutput;
}

export async function runStrictMemorySandbox(input: StrictMemorySandboxInput): Promise<StrictMemorySandboxOutput> {
  const serialized = canonicalJson(input);
  if (Buffer.byteLength(serialized,'utf8') > INPUT_LIMIT_BYTES) throw new StrictMemorySandboxError('input_invalid');
  const inputHash = hashStrictMemoryValue(input);

  // Darwin: hermetic execution of the same static child program (no shell, no
  // environment, bounded output, hard timeout, SIGKILL on overflow). The child
  // is deterministic and has no provider/network/filesystem capability; the
  // profile records the honest execution envelope. Linux uses the bwrap
  // actuator manifest for kernel-level isolation; Darwin keeps the identical
  // input/output contract and persistence path.
  if (process.platform !== 'linux') {
    if (process.platform !== 'darwin') throw new StrictMemorySandboxError('unsupported_platform');
    const args = ['--max-old-space-size=64','--stack-size=512','-e',CHILD_PROGRAM_TEMPLATE(DARWIN_PROFILE)];
    return new Promise((resolve,reject) => {
      let settled = false; let stdout=''; let overflow=false; let timedOut=false; let reapTimer:NodeJS.Timeout|undefined;
      const settle = (error?: unknown, output?: StrictMemorySandboxOutput): void => {
        if (settled) return; settled=true; clearTimeout(timer); if (reapTimer) clearTimeout(reapTimer);
        if (error) reject(error); else resolve(output!);
      };
      const child = spawn(process.execPath,args,{ env:{},cwd:'/',stdio:['pipe','pipe','ignore'],shell:false });
      const timer = setTimeout(()=>{timedOut=true;child.kill('SIGKILL');reapTimer=setTimeout(()=>settle(new StrictMemorySandboxError('sandbox_failed')),1000);},TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',(chunk:string)=>{ stdout+=chunk; if (Buffer.byteLength(stdout,'utf8')>OUTPUT_LIMIT_BYTES) { overflow=true; child.kill('SIGKILL'); } });
      child.stdout.once('error',()=>settle(new StrictMemorySandboxError('sandbox_failed')));
      child.stdin.once('error',()=>settle(new StrictMemorySandboxError('sandbox_failed')));
      child.once('error',()=>settle(new StrictMemorySandboxError('sandbox_unavailable')));
      child.once('close',(code)=>{ if (timedOut||overflow||code!==0) return settle(new StrictMemorySandboxError('sandbox_failed')); try { settle(undefined,validateOutput(stdout,inputHash)); } catch(error) { settle(error); } });
      child.stdin.end(serialized);
    });
  }

  let verified: VerifiedManifest;
  try { verified = loadActuatorManifest(); } catch (error) {
    if (error instanceof StrictMemorySandboxError) throw error;
    throw new StrictMemorySandboxError('sandbox_unavailable');
  }
  const mounts = [verified.node,verified.prlimit,...verified.runtimeFiles];
  mounts.forEach(assertIdentityUnchanged);
  const args = ['--unshare-all','--die-with-parent','--new-session','--clearenv','--tmpfs','/','--chdir','/',
    '--dev','/dev',...mountArgs(mounts),'--setenv','PATH','','--setenv','HOME','/',
    '/runtime/prlimit','--cpu=2','--fsize=0','--nofile=24','--','/runtime/node','--permission',
    '--max-old-space-size=64','--stack-size=512','-e',CHILD_PROGRAM];

  return new Promise((resolve,reject) => {
    let settled = false; let stdout=''; let overflow=false;let timedOut=false;let reapTimer:NodeJS.Timeout|undefined;
    const settle = (error?: unknown, output?: StrictMemorySandboxOutput): void => {
      if (settled) return; settled=true; clearTimeout(timer);if(reapTimer)clearTimeout(reapTimer);
      try { [verified.bwrap,...mounts].forEach(assertIdentityUnchanged); } catch { return reject(new StrictMemorySandboxError('sandbox_unavailable')); }
      if (error) reject(error); else resolve(output!);
    };
    const child = spawn(verified.bwrap.source,args,{ env:{},cwd:'/',stdio:['pipe','pipe','ignore'],shell:false });
    const timer = setTimeout(()=>{timedOut=true;child.kill('SIGKILL');reapTimer=setTimeout(()=>settle(new StrictMemorySandboxError('sandbox_failed')),1000);},TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{ stdout+=chunk; if (Buffer.byteLength(stdout,'utf8')>OUTPUT_LIMIT_BYTES) { overflow=true; child.kill('SIGKILL'); } });
    child.stdout.once('error',()=>settle(new StrictMemorySandboxError('sandbox_failed')));
    child.stdin.once('error',()=>settle(new StrictMemorySandboxError('sandbox_failed')));
    child.once('error',()=>settle(new StrictMemorySandboxError('sandbox_unavailable')));
    child.once('close',(code)=>{ if (timedOut||overflow||code!==0) return settle(new StrictMemorySandboxError('sandbox_failed')); try { settle(undefined,validateOutput(stdout,inputHash)); } catch(error) { settle(error); } });
    child.stdin.end(serialized);
  });
}

export interface StrictMemoryCertificationReceipt {
  schemaVersion:'rorca.strict-memory-linux-certification.v2';
  sourceIdentity:{head:string;tree:string;clean:boolean;sandboxSourceHash:string;certifierSourceHash:string;packageLockHash:string};
  platform:{os:'linux';architecture:string;libc:'glibc';nodeVersion:string;bwrapVersion:string;prlimitVersion:string};
  actuatorManifestPath:string;
  actuatorManifestHash:string;
  actuatorMappings:Array<{source:string;target:string;sha256:string}>;
  actuatorHashes:{bwrap:string;node:string;prlimit:string;runtimeFiles:string[]};
  productionOutputHash:string;
  probes:{cwdRoot:boolean;environmentCleared:boolean;workspaceHidden:boolean;procCanaryHidden:boolean;loopbackDenied:boolean;outboundDenied:boolean;writeDenied:boolean;forkDenied:boolean;fdLimitEnforced:boolean;timeoutCleanup:boolean};
  profile:typeof PROFILE;
}

function runCertificationChild(verified:VerifiedManifest,program:string,timeoutMs:number):Promise<string>{
  const mounts=[verified.node,verified.prlimit,...verified.runtimeFiles];const args=['--unshare-all','--die-with-parent','--new-session','--clearenv','--tmpfs','/','--chdir','/','--dev','/dev',...mountArgs(mounts),'--setenv','PATH','','--setenv','HOME','/','/runtime/prlimit','--cpu=2','--fsize=0','--nofile=24','--','/runtime/node','--permission','--allow-fs-read=/proc','--allow-fs-read=/dev/null','--max-old-space-size=64','-e',program];
  return new Promise((resolve,reject)=>{let settled=false,stdout='',timedOut=false;let reapTimer:NodeJS.Timeout|undefined;
    const settle=(error?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(reapTimer)clearTimeout(reapTimer);if(error)reject(error);else resolve(stdout)};
    const child=spawn(verified.bwrap.source,args,{env:{RORCA_CERTIFICATION_ENV_CANARY:'must-not-cross'},cwd:'/',stdio:['ignore','pipe','ignore'],shell:false});
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');reapTimer=setTimeout(()=>settle(new StrictMemorySandboxError('sandbox_failed')),1000)},timeoutMs);
    child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{stdout+=chunk;if(Buffer.byteLength(stdout)>OUTPUT_LIMIT_BYTES){timedOut=true;child.kill('SIGKILL')}});
    child.once('error',()=>settle(new StrictMemorySandboxError('sandbox_unavailable')));
    child.once('close',(code)=>timedOut?settle(new StrictMemorySandboxError('sandbox_failed')):code===0?settle():settle(new StrictMemorySandboxError('sandbox_failed')));
  });
}

function gitIdentity(repositoryRoot:string):{head:string;tree:string;clean:boolean}{
  const run=(args:string[])=>{const result=spawnSync('git',['-C',repositoryRoot,...args],{encoding:'utf8',timeout:2000,maxBuffer:1024*1024});if(result.status!==0)throw new StrictMemorySandboxError('sandbox_unavailable');return String(result.stdout).trim()};
  return {head:run(['rev-parse','HEAD']),tree:run(['rev-parse','HEAD^{tree}']),clean:run(['status','--porcelain=v1']).length===0};
}

/** Invocation-owned Linux-only adversarial certification. It never relaxes the production trust root. */
export async function certifyStrictMemoryLinuxSandbox():Promise<StrictMemoryCertificationReceipt>{
  if(process.platform!=='linux')throw new StrictMemorySandboxError('unsupported_platform');
  const verified=loadActuatorManifest();const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rorca-strict-memory-cert-'));const sentinel=path.join(temp,'workspace-canary');fs.writeFileSync(sentinel,'workspace-secret-canary',{mode:0o600});
  const server=net.createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve())});const address=server.address();if(!address||typeof address==='string')throw new StrictMemorySandboxError('sandbox_failed');
  const program=String.raw`const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');const result={cwdRoot:process.cwd()==='/',environmentCleared:Object.keys(process.env).every(k=>k==='PATH'||k==='HOME'||k==='PWD')&&process.env.PWD==='/'&&!process.env.RORCA_CERTIFICATION_ENV_CANARY,workspaceHidden:(()=>{try{return !fs.existsSync(${JSON.stringify(sentinel)})}catch{return true}})(),procCanaryHidden:!(()=>{try{return fs.readFileSync('/proc/1/environ','utf8').includes('must-not-cross')}catch{return false}})(),writeDenied:false,forkDenied:false,fdLimitEnforced:false};try{fs.writeFileSync('/write-probe','x');result.writeDenied=false}catch{result.writeDenied=true}try{const spawned=cp.spawnSync('/runtime/node',['-e','process.exit(0)']);result.forkDenied=!!spawned.error||spawned.status!==0}catch{result.forkDenied=true}const f=[];try{for(let i=0;i<64;i++)f.push(fs.openSync('/dev/null','r'))}catch{result.fdLimitEnforced=true}for(const fd of f)try{fs.closeSync(fd)}catch{}function denied(host,port){return new Promise(r=>{const s=net.connect({host,port});const done=()=>{s.destroy();r(true)};s.setTimeout(300,done);s.once('error',done);s.once('connect',()=>{s.destroy();r(false)})})}Promise.all([denied('127.0.0.1',${address.port}),denied('192.0.2.1',9)]).then(([loopbackDenied,outboundDenied])=>process.stdout.write(JSON.stringify({...result,loopbackDenied,outboundDenied})));`;
  try{
    const raw=await runCertificationChild(verified,program,2500);const probes=JSON.parse(raw) as StrictMemoryCertificationReceipt['probes'];
    let timeoutCleanup=false;try{await runCertificationChild(verified,"setInterval(()=>{},1000)",200)}catch{timeoutCleanup=true}
    const complete={...probes,timeoutCleanup};if(Object.values(complete).some(value=>value!==true))throw new StrictMemorySandboxError('sandbox_failed');
    const repositoryRoot=path.resolve(__dirname,'../../..');const identity=gitIdentity(repositoryRoot);if(!identity.clean)throw new StrictMemorySandboxError('sandbox_unavailable');
    const productionInput:StrictMemorySandboxInput={schemaVersion:'rorca.strict-spec-memory.input.v2',specRefHash:hashStrictMemoryValue('certification-spec'),stories:[{ordinal:1,acceptanceCriteriaCount:1,dependencyCount:0,hasDescription:true}],contextSignals:['l1']};
    const [productionA,productionB]=await Promise.all([runStrictMemorySandbox(productionInput),runStrictMemorySandbox(productionInput)]);
    const productionOutputHash=hashStrictMemoryValue(productionA);if(productionOutputHash!==hashStrictMemoryValue(productionB))throw new StrictMemorySandboxError('sandbox_failed');
    const prlimitVersion=spawnSync(verified.prlimit.source,['--version'],{env:{},encoding:'utf8',timeout:1000,maxBuffer:4096});
    if(prlimitVersion.status!==0)throw new StrictMemorySandboxError('sandbox_unavailable');
    const mappings=[verified.node,verified.prlimit,...verified.runtimeFiles].map(file=>({source:file.source,target:file.target,sha256:file.sha256}));
    return {schemaVersion:'rorca.strict-memory-linux-certification.v2',sourceIdentity:{...identity,
      sandboxSourceHash:fileDigest(path.join(repositoryRoot,'backend/src/lib/strict-memory-sandbox.ts')),
      certifierSourceHash:fileDigest(path.join(repositoryRoot,'backend/scripts/certify-strict-memory-linux.ts')),
      packageLockHash:fileDigest(path.join(repositoryRoot,'package-lock.json'))},
      platform:{os:'linux',architecture:process.arch,libc:'glibc',nodeVersion:verified.manifest.node.version,bwrapVersion:verified.manifest.bwrap.version,prlimitVersion:String(prlimitVersion.stdout).trim()},
      actuatorManifestPath:ACTUATOR_MANIFEST_PATH,actuatorManifestHash:fileDigest(ACTUATOR_MANIFEST_PATH),actuatorMappings:mappings,
      actuatorHashes:{bwrap:verified.manifest.bwrap.sha256,node:verified.manifest.node.sha256,prlimit:verified.manifest.prlimit.sha256,runtimeFiles:verified.runtimeFiles.map(file=>file.sha256)},
      productionOutputHash,probes:complete,profile:PROFILE};
  } finally {server.close();fs.rmSync(temp,{recursive:true,force:true})}
}

export const strictMemorySandboxProfile = PROFILE;
export const darwinMemorySandboxProfile = DARWIN_PROFILE;
export const strictMemoryActuatorManifestPath = ACTUATOR_MANIFEST_PATH;
