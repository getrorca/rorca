/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import { json, Router, type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { AuthError, PayloadTooLargeError, TooManyRequestsError, ValidationError } from '../lib/errors';
import { FederatedHostVerifier, type FederatedHostVerification, type FederatedHostVerificationPorts } from '../lib/federated-host-verifier';
import type { FederatedResultProposal } from '../lib/federated-runtime-contracts';
import {
  FederatedRuntimeService, createDatabaseFederatedHostVerificationPorts, type FederatedAuthenticatedRuntime,
} from '../lib/federated-runtime-service';
import { bridgeFederatedResultToForgejo } from '../lib/forgejo-federation-bridge';
import { loadCanonicalWave4FederationGate } from '../lib/wave4-federation-gate';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 120;
interface RateWindow { startedAt: number; count: number }

export type FederatedServiceProvider = () => Promise<FederatedRuntimeService>;

let canonicalService: Promise<FederatedRuntimeService> | null = null;
function defaultService(): Promise<FederatedRuntimeService> {
  canonicalService ??= loadCanonicalWave4FederationGate().then((gate) => {
    const ports = createDatabaseFederatedHostVerificationPorts();
    return new FederatedRuntimeService(
      gate, new FederatedHostVerifier(ports), hostForgejoProjectionAdapter(ports),
    );
  });
  return canonicalService;
}

/** Host-owned W5-005 projection adapter (A4): derives the frozen run/base/
 * worktree identity from the host-verified proposal and enqueues the Forgejo
 * projection with a deterministic idempotency key. The proposal posture is
 * never changed (closeoutAuthority stays 'none'); failures are durably
 * recorded by the bridge for the reconcile loop — never silently omitted. */
function hostForgejoProjectionAdapter(ports: FederatedHostVerificationPorts) {
  return async (input: {
    workspaceId: string;
    proposal: FederatedResultProposal;
    hostVerification: FederatedHostVerification;
    proposalHash: string;
  }): Promise<void> => {
    const worktree = await ports.loadWorktree(input.workspaceId, input.proposal.binding.worktreeId);
    await bridgeFederatedResultToForgejo({
      workspaceId: input.workspaceId,
      proposal: input.proposal,
      hostVerification: input.hostVerification,
      proposalHash: input.proposalHash,
      idempotencyKey: `forgejo-bridge:${input.workspaceId}:${input.proposalHash}`,
      baseBranch: 'main',
      baseSha: input.proposal.binding.baseSha,
      branchName: input.proposal.binding.worktreeId,
      workspaceRealpath: worktree?.sourceCheckoutPath ?? undefined,
      worktreeRealpath: worktree?.worktreePath ?? undefined,
    });
  };
}

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? '' : String(value ?? '').trim();
}

function parsePositiveHeader(req: Request, name: string): number {
  const value = Number(header(req, name));
  if (!Number.isSafeInteger(value) || value < 1) throw new AuthError('Federated runtime authentication failed');
  return value;
}

async function authenticate(req: Request, service: FederatedRuntimeService): Promise<FederatedAuthenticatedRuntime> {
  if (process.env.NODE_ENV === 'production' && !req.secure) {
    throw new AuthError('Federated runtime TLS boundary required');
  }
  const authorization = header(req, 'authorization');
  if (!authorization.startsWith('Federated ')) throw new AuthError('Federated runtime authentication required');
  return service.authenticate({ workspaceId: header(req, 'x-rorca-workspace-id'), runtimeId: header(req, 'x-rorca-runtime-id'),
    credentialVersion: parsePositiveHeader(req, 'x-rorca-credential-version'), keyVersion: parsePositiveHeader(req, 'x-rorca-key-version'),
    credential: authorization.slice('Federated '.length) });
}

function asyncRoute(provider: FederatedServiceProvider, rate: Map<string, RateWindow>, windowMs: number, maxRequestsPerWindow: number,
  handler: (service: FederatedRuntimeService, runtime: FederatedAuthenticatedRuntime, req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.setTimeout(30_000);
      const service = await provider();
      const runtime = await authenticate(req, service);
      const now = Date.now();
      const current = rate.get(runtime.runtimeId);
      const window = !current || now - current.startedAt >= windowMs ? { startedAt: now, count: 0 } : current;
      window.count += 1;
      rate.clear();
      rate.set(runtime.runtimeId, window);
      if (window.count > maxRequestsPerWindow) throw new TooManyRequestsError('Federated runtime rate limit exceeded');
      await handler(service, runtime, req, res);
    } catch (error) {
      if (error instanceof ZodError) next(new ValidationError('Federated request schema is invalid', { issues: error.issues }));
      else next(error);
    }
  };
}

export interface FederatedRateLimitOptions { windowMs?: number; maxRequestsPerWindow?: number }
export function createFederatedRuntimeRouter(
  provider: FederatedServiceProvider = defaultService,
  rateLimitOptions: FederatedRateLimitOptions = {},
): Router {
  const router = Router();
  const windowMs = rateLimitOptions.windowMs ?? DEFAULT_WINDOW_MS;
  const maxRequestsPerWindow = rateLimitOptions.maxRequestsPerWindow ?? DEFAULT_MAX_REQUESTS_PER_WINDOW;
  const rate = new Map<string, RateWindow>();
  router.use(json({ limit: '256kb', strict: true }));
  router.use((error: unknown, _req: Request, _res: Response, next: NextFunction) => {
    const parserError = error as { type?: string };
    next(parserError.type === 'entity.too.large'
      ? new PayloadTooLargeError('Federated runtime payload exceeds 256 KiB')
      : error);
  });

  /** @swagger
   * /api/mission-control/v1/federation/discover:
   *   post:
   *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: Authenticated bounded discovery for the single pilot runtime; grants no execution authority.
   */
  router.post('/discover', asyncRoute(provider, rate, windowMs, maxRequestsPerWindow, async (service, runtime, req, res) => {
    res.json(await service.discover(runtime, req.body));
  }));
  /** @swagger
   * /api/mission-control/v1/federation/acquire:
   *   post:
   *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: Atomically claims one exact canonical lease and work-package binding.
   */
  router.post('/acquire', asyncRoute(provider, rate, windowMs, maxRequestsPerWindow, async (service, runtime, req, res) => {
    res.json(await service.acquire(runtime, req.body));
  }));
  /** @swagger
   * /api/mission-control/v1/federation/work-package/read:
   *   post:
   *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: Returns exact lease-scoped canonical inputs without host paths or credentials.
   */
  router.post('/work-package/read', asyncRoute(provider, rate, windowMs, maxRequestsPerWindow, async (service, runtime, req, res) => {
    res.json(await service.readWorkPackage(runtime, req.body));
  }));
  /** @swagger
   * /api/mission-control/v1/federation/leases/renew:
   *   post:
   *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: Renews only the exact active database-time lease fence.
   */
  router.post('/leases/renew', asyncRoute(provider, rate, windowMs, maxRequestsPerWindow, async (service, runtime, req, res) => {
    res.json(await service.renew(runtime, req.body));
  }));
  /** @swagger
   * /api/mission-control/v1/federation/leases/release:
   *   post:
   *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: Releases only the exact active lease and permanently fences later writes.
   */
  router.post('/leases/release', asyncRoute(provider, rate, windowMs, maxRequestsPerWindow, async (service, runtime, req, res) => {
    res.json(await service.release(runtime, req.body));
  }));
  /** @swagger
   * /api/mission-control/v1/federation/events:
   *   post:
   *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: Idempotent runtime-asserted execution event ingestion with no lifecycle authority.
   */
  router.post('/events', asyncRoute(provider, rate, windowMs, maxRequestsPerWindow, async (service, runtime, req, res) => {
    res.json(await service.ingestEvent(runtime, req.body));
  }));
  /** @swagger
   * /api/mission-control/v1/federation/activity:
   *   post:
   *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: Bounded redacted observability-only activity ingestion.
   */
  router.post('/activity', asyncRoute(provider, rate, windowMs, maxRequestsPerWindow, async (service, runtime, req, res) => {
    res.json(await service.ingestActivity(runtime, req.body));
  }));
  /** @swagger
   * /api/mission-control/v1/federation/results/propose:
   *   post:
   *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: Accepts a proposal only after independent host Git validation and artifact verification.
   */
  router.post('/results/propose', asyncRoute(provider, rate, windowMs, maxRequestsPerWindow, async (service, runtime, req, res) => {
    res.json(await service.proposeResult(runtime, req.body));
  }));
  /** @swagger
   * /api/mission-control/v1/federation/cancellations/acknowledge:
   *   post:
   *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: Exact-fence same-generation cancellation acknowledgement only.
   */
  router.post('/cancellations/acknowledge', asyncRoute(provider, rate, windowMs, maxRequestsPerWindow, async (service, runtime, req, res) => {
    res.json(await service.acknowledgeCancellation(runtime, req.body));
  }));
  /** @swagger
   * /api/mission-control/v1/federation/plan-changes/propose:
   *   post:
   *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: Proposal-only plan change seam; never self-authorizes a revision or scope expansion.
   */
  router.post('/plan-changes/propose', asyncRoute(provider, rate, windowMs, maxRequestsPerWindow, async (service, runtime, req, res) => {
    res.json(await service.proposePlanChange(runtime, req.body));
  }));
  /** @swagger
   * /api/mission-control/v1/federation/recover:
   *   post:
   *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: Canonical-record-only reconciliation that never relaunches or infers success.
   */
  router.post('/recover', asyncRoute(provider, rate, windowMs, maxRequestsPerWindow, async (service, runtime, req, res) => {
    res.json(await service.recover(runtime, req.body));
  }));
  return router;
}

export default createFederatedRuntimeRouter();
