/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  CurrentExecutionEngineBridge,
  ManagedEngineRequest,
  ManagedHostObservation,
  ManagedResultProposal,
} from './rorca-managed-executor';

export interface ManagedEngineLauncher {
  readonly bin: string;
  readonly args: readonly string[];
}

interface OwnedEngineProcess {
  readonly child: ChildProcess;
  readonly processIdentity: string;
  readonly outputHash: crypto.Hash;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  diagnosticCode: string | null;
  settled: boolean;
}

export const ENGINE_ENV_REMOVE = [
  'CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_AGENT_SDK_VERSION','CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'RORCA_QUALIFICATION_TRUSTED_ISSUERS_JSON','RORCA_WAVE_PRODUCTION_ACTIVATION_KEY',
  'GITHUB_TOKEN','GH_TOKEN','GITHUB_APP_PRIVATE_KEY','GITHUB_PRIVATE_KEY',
] as const;

export function normalizedManagedFailureStatus(input: Readonly<{
  cancelled: boolean; timedOut: boolean; outputLimited: boolean; validationFailed: boolean;
  providerFailure: boolean; fenceLost: boolean;
}>): ManagedResultProposal['status'] {
  if (input.fenceLost) return 'fenced';
  if (input.cancelled) return 'cancelled';
  if (input.timedOut) return 'timed_out';
  if (input.outputLimited) return 'output_limited';
  if (input.providerFailure) return 'provider_failed';
  if (input.validationFailed) return 'validation_failed';
  return 'failed';
}

/**
 * Process bridge around the existing execution-engine entrypoint. It does not
 * implement provider logic, lifecycle decisions, release, merge, or deploy.
 */
export class CurrentEngineManagedBridge implements CurrentExecutionEngineBridge {
  private readonly processes = new Map<string, OwnedEngineProcess>();

  constructor(
    private readonly launcher: ManagedEngineLauncher,
    private readonly trustedEngineEnvironment: Readonly<NodeJS.ProcessEnv>,
    private readonly terminationGraceMs = 5_000,
    private readonly killProofTimeoutMs = 5_000,
  ) {}

  async launch(request: ManagedEngineRequest, launchToken: string): Promise<{ processIdentity: string }> {
    if (this.processes.has(request.requestHash)) throw new Error('Managed engine request already owns a process');
    const runId = typeof request.runId === 'number' ? String(request.runId) : request.runId;
    const engineArgs = [
      ...this.launcher.args,
      '--json',path.resolve(request.repositoryPath,request.canonicalSpecPath),
      '--cwd',request.worktreePath,'--run-id',runId,'--workspace-id',request.workspaceId,
      '--story',request.storyId,'--parallelism','1','--agent',request.agent,'--terminal-mode',request.terminalMode,
      '--worktree-path',request.worktreePath,'--branch-name',request.branchName,'--workspace-path',request.repositoryPath,
    ];
    if (request.model) engineArgs.push('--model',request.model);
    const env: NodeJS.ProcessEnv = {
      ...this.trustedEngineEnvironment,
      RORCA_PROCESS_ROLE: 'engine',
      RORCA_WORKSPACE_ID: request.workspaceId,
      RORCA_ENGINE_START_GATE_TOKEN: launchToken,
      RORCA_MANAGED_REQUEST_HASH: request.requestHash,
      RORCA_MANAGED_ATTEMPT_ID: request.attemptId,
      RORCA_MANAGED_GENERATION: String(request.generation),
      RORCA_MANAGED_LEASE_ID: request.leaseId,
      RORCA_MANAGED_FENCING_TOKEN: String(request.fencingToken),
      RORCA_MANAGED_CAPABILITY_SNAPSHOT_HASH: request.capabilitySnapshotHash,
      RORCA_MANAGED_QUOTA_RESERVATION_ID: request.quotaReservationId,
    };
    for (const key of ENGINE_ENV_REMOVE) delete env[key];
    const child = spawn(this.launcher.bin,engineArgs,{ cwd:request.worktreePath,stdio:['ignore','pipe','pipe','ipc'],env });
    const processIdentity = `managed:${child.pid ?? 'pending'}:${crypto.createHash('sha256').update(`${request.requestHash}:${launchToken}`).digest('hex')}`;
    const owned: OwnedEngineProcess = {
      child,processIdentity,outputHash:crypto.createHash('sha256'),exitCode:null,exitSignal:null,
      diagnosticCode:null,settled:false,
    };
    this.processes.set(request.requestHash,owned);
    child.stdout?.on('data',(chunk: Buffer | string) => owned.outputHash.update(chunk));
    child.stderr?.on('data',(chunk: Buffer | string) => owned.outputHash.update(chunk));
    child.once('error',(error) => { owned.diagnosticCode=`engine_spawn:${error.name}`; owned.settled=true; });
    child.once('close',(code,signal) => {
      owned.exitCode=code;
      owned.exitSignal=signal as NodeJS.Signals | null;
      owned.settled=true;
      if (code !== 0 && !owned.diagnosticCode) owned.diagnosticCode='engine_nonzero_exit';
    });
    await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>{
        child.kill('SIGTERM');
        reject(new Error('Current execution engine did not acknowledge the managed launch gate'));
      },10_000);
      timeout.unref();
      const cleanup=()=>{clearTimeout(timeout);child.off('message',onMessage);child.off('error',onError);child.off('close',onClose);};
      const onMessage=(message:unknown)=>{
        if(!message||typeof message!=='object'||(message as Record<string,unknown>).type!=='pid')return;
        cleanup();resolve();
      };
      const onError=(error:Error)=>{cleanup();reject(error);};
      const onClose=()=>{cleanup();reject(new Error('Current execution engine closed before managed launch acknowledgement'));};
      child.on('message',onMessage);child.once('error',onError);child.once('close',onClose);
      child.send({type:'launch_start',token:launchToken},(error)=>{if(error)onError(error);});
    });
    return { processIdentity };
  }

  private async waitForDeath(owned: OwnedEngineProcess, timeoutMs: number): Promise<boolean> {
    if (owned.settled) return true;
    const {promise,resolve}=Promise.withResolvers<boolean>();
    let finished=false;
    const finish=(dead:boolean)=>{
      if(finished)return;
      finished=true;
      clearTimeout(timer);
      owned.child.off('close',onClose);
      resolve(dead);
    };
    const onClose=()=>finish(true);
    const timer=setTimeout(()=>finish(owned.settled),timeoutMs);
    timer.unref();
    owned.child.once('close',onClose);
    if(owned.settled)finish(true);
    return promise;
  }

  async cancel(request: ManagedEngineRequest, reasonCode: string): Promise<ManagedHostObservation> {
    const owned = this.processes.get(request.requestHash);
    if (!owned) return Object.freeze({ live:false,processIdentity:null,exitCode:null,exitSignal:null,outputHash:null,diagnosticCode:'process_not_found' });
    owned.diagnosticCode=`cancelled:${reasonCode}`;
    if (!owned.settled) {
      owned.child.kill('SIGTERM');
      const terminated = await this.waitForDeath(owned,this.terminationGraceMs);
      if (!terminated && !owned.settled) {
        owned.child.kill('SIGKILL');
        const killed=await this.waitForDeath(owned,this.killProofTimeoutMs);
        if(!killed)owned.diagnosticCode=`quiescence_unproven:${reasonCode}`;
      }
    }
    return this.observe(request);
  }

  async terminate(request: ManagedEngineRequest, reasonCode: string): Promise<ManagedHostObservation> {
    return this.cancel(request,`fenced:${reasonCode}`);
  }

  async observe(request: ManagedEngineRequest): Promise<ManagedHostObservation> {
    const owned = this.processes.get(request.requestHash);
    if (!owned) return Object.freeze({ live:false,processIdentity:null,exitCode:null,exitSignal:null,outputHash:null,diagnosticCode:'process_not_found' });
    return Object.freeze({
      live:!owned.settled,processIdentity:owned.processIdentity,exitCode:owned.exitCode,exitSignal:owned.exitSignal,
      outputHash:owned.settled ? `sha256:${owned.outputHash.copy().digest('hex')}` : null,
      diagnosticCode:owned.diagnosticCode,
    });
  }
}
