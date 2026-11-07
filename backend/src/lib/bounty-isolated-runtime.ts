/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Fail-closed, proposal-only execution contract for fresh bounty model workers.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, basename, dirname, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { hashBountyContract, parseCanonicalJson } from './bounty-contracts';
import { ForbiddenError, ValidationError } from './errors';

const HASH_SCHEMA = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const UUID_SCHEMA = z.string().uuid();
const ID_SCHEMA = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const TARGET_TOOLS = ['target.observe.v1', 'target.test.v1'] as const;
const MAX_PACKAGE_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 1_000_000;

export const BountyIsolatedPackageSchema = z.object({
  version: z.literal('bounty-isolated-package.v1'),
  immutablePayloadHash: HASH_SCHEMA,
  routePackageHash: HASH_SCHEMA,
  missionId: UUID_SCHEMA,
  workPackageId: UUID_SCHEMA,
  attemptId: UUID_SCHEMA,
  authorityEpoch: z.number().int().positive(),
  capabilityExpiresAt: z.string().datetime({ offset: true }),
  contextNonce: UUID_SCHEMA,
  objective: z.object({ id: ID_SCHEMA, objectiveClass: ID_SCHEMA, prompt: z.string().min(1).max(128_000) }).strict(),
  targetBroker: z.object({ socketIdentity: HASH_SCHEMA, allowedTools: z.array(z.enum(TARGET_TOOLS)).min(1).max(TARGET_TOOLS.length) }).strict(),
  provider: z.object({ policyHash: HASH_SCHEMA, exactOriginHash: HASH_SCHEMA }).strict(),
  evidenceRefs: z.array(z.object({ evidenceId: ID_SCHEMA, evidenceHash: HASH_SCHEMA }).strict()).max(256),
  outputSchema: z.object({ schemaId: z.literal('bounty-worker-proposal.v1'), schemaHash: HASH_SCHEMA }).strict(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.targetBroker.allowedTools).size !== value.targetBroker.allowedTools.length) {
    ctx.addIssue({ code: 'custom', path: ['targetBroker', 'allowedTools'], message: 'broker tools must be unique' });
  }
});
export type BountyIsolatedPackage = z.infer<typeof BountyIsolatedPackageSchema>;

export const BountyTargetToolRequestSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('target.observe.v1'), requestId: UUID_SCHEMA, targetId: ID_SCHEMA, inputHash: HASH_SCHEMA }).strict(),
  z.object({ tool: z.literal('target.test.v1'), requestId: UUID_SCHEMA, targetId: ID_SCHEMA, inputHash: HASH_SCHEMA }).strict(),
]);
export const BountyTargetBrokerRequestSchema = z.object({
  version: z.literal('bounty-target-broker.v1'),
  immutablePayloadHash: HASH_SCHEMA,
  missionId: UUID_SCHEMA,
  workPackageId: UUID_SCHEMA,
  attemptId: UUID_SCHEMA,
  contextNonce: UUID_SCHEMA,
  request: BountyTargetToolRequestSchema,
}).strict();
export const BountyTargetBrokerResponseSchema = z.object({
  version: z.literal('bounty-target-broker-result.v1'),
  requestId: UUID_SCHEMA,
  outcome: z.enum(['observed', 'denied', 'failed']),
  resultHash: HASH_SCHEMA,
  untrustedText: z.string().max(128_000),
}).strict();

/** The provider protocol starts a new inference and has no conversation/session continuation field. */
export const BountyProviderInferenceRequestSchema = z.object({
  version: z.literal('bounty-provider-inference.v1'),
  packageHash: HASH_SCHEMA,
  contextNonce: UUID_SCHEMA,
  prompt: z.string().min(1).max(128_000),
}).strict();
export const BountyProviderInferenceResponseSchema = z.object({
  version: z.literal('bounty-provider-inference-result.v1'),
  packageHash: HASH_SCHEMA,
  contextNonce: UUID_SCHEMA,
  text: z.string().max(1_000_000),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict(),
}).strict();

export const BountyWorkerProposalSchema = z.object({
  version: z.literal('bounty-worker-proposal.v1'),
  disposition: z.literal('proposal-only'),
  authorityEffect: z.literal('none'),
  evidenceAdmission: z.literal(false),
  findingAdmission: z.literal(false),
  immutablePayloadHash: HASH_SCHEMA,
  routePackageHash: HASH_SCHEMA,
  missionId: UUID_SCHEMA,
  workPackageId: UUID_SCHEMA,
  attemptId: UUID_SCHEMA,
  contextNonce: UUID_SCHEMA,
  summary: z.string().min(1).max(16_384),
  claims: z.array(z.object({ claim: z.string().min(1).max(8_192), confidence: z.number().min(0).max(1), citationHashes: z.array(HASH_SCHEMA).max(64) }).strict()).max(256),
  proposedToolRequests: z.array(BountyTargetToolRequestSchema).max(256),
}).strict();
export type BountyWorkerProposal = z.infer<typeof BountyWorkerProposalSchema>;

export const BOUNTY_PROPOSAL_SCHEMA_HASH = hashBountyContract('isolated-proposal-schema', {
  version: 'bounty-worker-proposal.v1',
  disposition: 'proposal-only',
  authorityEffect: 'none',
  evidenceAdmission: false,
  findingAdmission: false,
  targetTools: TARGET_TOOLS,
});

export interface RuleOfTwoExposure {
  untrustedTargetInput: boolean;
  sensitiveCredentialsOrEvidence: boolean;
  unrestrictedEgress: boolean;
}

/** No component may combine all three Rule-of-Two risk classes. */
export function assertRuleOfTwo(exposure: RuleOfTwoExposure): void {
  if (Object.values(exposure).filter(Boolean).length > 2) {
    throw new ForbiddenError('Rule-of-Two violation: untrusted input, sensitive material, and unrestricted egress may not coexist');
  }
}

export const BOUNTY_BOUNDARY_PROBES = Object.freeze([
  { id: 'localhost', boundary: 'network-namespace', expected: 'denied' },
  { id: 'arbitrary-unix-socket', boundary: 'socket-allowlist', expected: 'denied' },
  { id: 'dns', boundary: 'network-namespace', expected: 'denied' },
  { id: 'tcp', boundary: 'network-namespace', expected: 'denied' },
  { id: 'udp', boundary: 'network-namespace', expected: 'denied' },
  { id: 'inherited-descriptors', boundary: 'descriptor-closure', expected: 'denied' },
  { id: 'host-proc', boundary: 'private-proc', expected: 'denied' },
  { id: 'executable-roots', boundary: 'single-executable', expected: 'denied' },
  { id: 'secret-files', boundary: 'empty-root', expected: 'denied' },
  { id: 'stale-capabilities', boundary: 'epoch-and-expiry', expected: 'denied' },
] as const);

export interface IsolatedRuntimeConfig {
  bwrapExecutable?: string;
  workerExecutable: string;
  workerExecutableHash: string;
  targetBrokerRoot: string;
  targetBrokerSocket: string;
  targetBrokerSocketIdentity: string;
  providerBrokerRoot: string;
  providerBrokerSocket: string;
  providerExactOrigin: string;
  providerPolicyHash: string;
  expectedMissionId: string;
  expectedWorkPackageId: string;
  expectedRoutePackageHash: string;
  expectedAuthorityEpoch: number;
  timeoutMs?: number;
}

export interface BwrapInvocation { executable: string; args: string[]; env: Record<string, string>; stdio: ['ignore', 'pipe', 'pipe', number] }

function packageHashInput(value: BountyIsolatedPackage): Omit<BountyIsolatedPackage, 'immutablePayloadHash'> {
  const { immutablePayloadHash: _immutablePayloadHash, ...body } = value;
  return body;
}

export function verifyIsolatedPackage(raw: unknown, config: Pick<IsolatedRuntimeConfig, 'targetBrokerSocketIdentity' | 'providerExactOrigin' | 'providerPolicyHash' | 'expectedMissionId' | 'expectedWorkPackageId' | 'expectedRoutePackageHash' | 'expectedAuthorityEpoch'>, now = Date.now()): BountyIsolatedPackage {
  const value = BountyIsolatedPackageSchema.parse(raw);
  if (hashBountyContract('isolated-worker-package', packageHashInput(value)) !== value.immutablePayloadHash) throw new ValidationError('immutable package payload hash mismatch');
  if (value.missionId !== config.expectedMissionId || value.workPackageId !== config.expectedWorkPackageId || value.routePackageHash !== config.expectedRoutePackageHash) throw new ForbiddenError('immutable package identity does not match the dispatched work');
  if (value.outputSchema.schemaHash !== BOUNTY_PROPOSAL_SCHEMA_HASH) throw new ValidationError('proposal output schema is not pinned');
  if (value.targetBroker.socketIdentity !== config.targetBrokerSocketIdentity) throw new ForbiddenError('target broker identity does not match immutable package');
  if (value.provider.policyHash !== config.providerPolicyHash || value.provider.exactOriginHash !== hashBountyContract('provider-origin', exactProviderOrigin(config.providerExactOrigin))) throw new ForbiddenError('provider broker policy does not match immutable package');
  if (value.authorityEpoch !== config.expectedAuthorityEpoch || Date.parse(value.capabilityExpiresAt) <= now) throw new ForbiddenError('worker capability is stale');
  assertRuleOfTwo({ untrustedTargetInput: true, sensitiveCredentialsOrEvidence: false, unrestrictedEgress: false });
  return value;
}

export function validateBountyWorkerProposal(raw: string, workPackage: BountyIsolatedPackage, now = Date.now()): BountyWorkerProposal {
  if (Date.parse(workPackage.capabilityExpiresAt) <= now) throw new ForbiddenError('worker capability expired before proposal validation');
  if (Buffer.byteLength(raw, 'utf8') > MAX_OUTPUT_BYTES) throw new ValidationError('worker proposal exceeds 1 MB');
  const proposal = BountyWorkerProposalSchema.parse(parseCanonicalJson(raw));
  for (const field of ['immutablePayloadHash', 'routePackageHash', 'missionId', 'workPackageId', 'attemptId', 'contextNonce'] as const) {
    if (proposal[field] !== workPackage[field]) throw new ForbiddenError(`proposal ${field} does not match immutable package`);
  }
  const allowed = new Set(workPackage.targetBroker.allowedTools);
  if (proposal.proposedToolRequests.some((request) => !allowed.has(request.tool))) throw new ForbiddenError('proposal requests a tool absent from the immutable package');
  return proposal;
}

function exactProviderOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationError('provider origin must be an exact HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== value) {
    throw new ValidationError('provider origin must be an exact HTTPS origin without credentials, path, query, or fragment');
  }
  return value;
}

function assertAbsolute(value: string, label: string): void {
  if (!isAbsolute(value) || resolve(value) !== value) throw new ValidationError(`${label} must be a normalized absolute path`);
}

/** Pure invocation builder; filesystem identity checks occur immediately before this is spawned. */
export function buildBwrapInvocation(workPackage: BountyIsolatedPackage, config: IsolatedRuntimeConfig, packageFd = 3): BwrapInvocation {
  assertAbsolute(config.bwrapExecutable ?? '/usr/bin/bwrap', 'bwrap executable');
  assertAbsolute(config.workerExecutable, 'worker executable');
  if (config.targetBrokerRoot === config.providerBrokerRoot || config.targetBrokerSocket === config.providerBrokerSocket) throw new ForbiddenError('target and provider brokers must be distinct');
  if (basename(config.targetBrokerSocket) !== `${workPackage.missionId}.sock`) throw new ForbiddenError('target broker socket is not mission-bound');
  exactProviderOrigin(config.providerExactOrigin);
  const args = [
    '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--unshare-net',
    '--uid', '65534', '--gid', '65534', '--cap-drop', 'ALL', '--clearenv',
    '--tmpfs', '/', '--dir', '/runtime', '--dir', '/run', '--dir', '/run/rorca', '--tmpfs', '/tmp', '--tmpfs', '/home', '--proc', '/proc', '--dev', '/dev',
    '--ro-bind', config.workerExecutable, '/runtime/worker', '--ro-bind-data', String(packageFd), '/run/rorca/package.json',
    '--ro-bind', config.targetBrokerSocket, '/run/rorca/target.sock', '--ro-bind', config.providerBrokerSocket, '/run/rorca/provider.sock',
    '--setenv', 'HOME', '/home', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'RORCA_PACKAGE', '/run/rorca/package.json', '--setenv', 'RORCA_TARGET_BROKER', '/run/rorca/target.sock', '--setenv', 'RORCA_PROVIDER_BROKER', '/run/rorca/provider.sock',
    '--', '/runtime/worker',
  ];
  return { executable: config.bwrapExecutable ?? '/usr/bin/bwrap', args, env: {}, stdio: ['ignore', 'pipe', 'pipe', packageFd] };
}

async function assertTrustedPath(path: string, expected: 'file' | 'socket', expectedHash?: string): Promise<Stats> {
  assertAbsolute(path, expected);
  if (await realpath(path) !== path) throw new ForbiddenError(`${expected} path may not contain symlinks`);
  const info = await stat(path);
  if ((expected === 'file' && !info.isFile()) || (expected === 'socket' && !info.isSocket())) throw new ForbiddenError(`trusted ${expected} has the wrong file type`);
  if ((info.mode & 0o022) !== 0) throw new ForbiddenError(`trusted ${expected} may not be group/world writable`);
  if (expectedHash) {
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const digest = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
      if (`sha256:${digest.digest('hex')}` !== expectedHash) throw new ForbiddenError('worker executable hash mismatch');
    } finally { await handle.close(); }
  }
  return info;
}

async function assertBrokerSocket(root: string, socket: string): Promise<void> {
  assertAbsolute(root, 'broker root');
  assertAbsolute(socket, 'broker socket');
  const trustedRoot = await realpath(root);
  if (trustedRoot !== root || dirname(socket) !== root || relative(root, socket).startsWith('..')) throw new ForbiddenError('broker socket must be a direct child of its trusted root');
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory() || (rootInfo.mode & 0o022) !== 0) throw new ForbiddenError('broker root must not be group/world writable');
  await assertTrustedPath(socket, 'socket');
}

/** Launch exactly one package in one fresh process/model context and return only a validated proposal. */
export async function launchIsolatedBountyWorker(packagePath: string, config: IsolatedRuntimeConfig): Promise<BountyWorkerProposal> {
  if (process.platform !== 'linux') throw new ForbiddenError('isolated bounty workers require Linux bubblewrap');
  assertAbsolute(packagePath, 'package path');
  const packageFile = await open(packagePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await packageFile.stat();
    if (!info.isFile() || info.size > MAX_PACKAGE_BYTES || (info.mode & 0o222) !== 0) throw new ForbiddenError('package must be a read-only immutable regular file of at most 1 MB');
    const packageBytes = Buffer.alloc(info.size);
    let readOffset = 0;
    while (readOffset < packageBytes.length) {
      const { bytesRead } = await packageFile.read(packageBytes, readOffset, packageBytes.length - readOffset, readOffset);
      if (bytesRead === 0) throw new ValidationError('immutable package was truncated while reading');
      readOffset += bytesRead;
    }
    const workPackage = verifyIsolatedPackage(parseCanonicalJson(packageBytes.toString('utf8')), config);
    await Promise.all([
      assertTrustedPath(config.bwrapExecutable ?? '/usr/bin/bwrap', 'file'),
      assertTrustedPath(config.workerExecutable, 'file', config.workerExecutableHash),
      assertBrokerSocket(config.targetBrokerRoot, config.targetBrokerSocket),
      assertBrokerSocket(config.providerBrokerRoot, config.providerBrokerSocket),
    ]);
    const invocation = buildBwrapInvocation(workPackage, config, 3);
    return await new Promise<BountyWorkerProposal>((resolvePromise, rejectPromise) => {
      const child = spawn(invocation.executable, invocation.args, { env: invocation.env, stdio: ['ignore', 'pipe', 'pipe', packageFile.fd] });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0); let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0); let settled = false;
      const finish = (error?: unknown, proposal?: BountyWorkerProposal): void => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) rejectPromise(error); else resolvePromise(proposal!);
      };
      const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => Buffer.concat([current, chunk], current.length + chunk.length);
      child.stdout!.on('data', (chunk: Buffer<ArrayBufferLike>) => { stdout = append(stdout, chunk); if (stdout.length > MAX_OUTPUT_BYTES) child.kill('SIGKILL'); });
      child.stderr!.on('data', (chunk: Buffer<ArrayBufferLike>) => { stderr = append(stderr, chunk); if (stderr.length > 64 * 1024) child.kill('SIGKILL'); });
      child.once('error', finish);
      child.once('close', (code, signal) => {
        if (stdout.length > MAX_OUTPUT_BYTES) return finish(new ValidationError('worker proposal exceeds 1 MB'));
        if (code !== 0) return finish(new Error(`isolated bounty worker failed (${signal ?? code}): ${stderr.toString('utf8').slice(0, 4096)}`));
        try { finish(undefined, validateBountyWorkerProposal(stdout.toString('utf8'), workPackage)); } catch (error) { finish(error); }
      });
      const configuredTimeout = Math.max(1_000, Math.min(config.timeoutMs ?? 300_000, 900_000));
      const capabilityRemaining = Date.parse(workPackage.capabilityExpiresAt) - Date.now();
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('isolated bounty worker timed out or its capability expired')); }, Math.max(1, Math.min(configuredTimeout, capabilityRemaining)));
    });
  } finally { await packageFile.close(); }
}
