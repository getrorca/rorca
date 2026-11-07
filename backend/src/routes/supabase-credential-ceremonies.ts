/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z, type ZodType } from 'zod';
import { ValidationError } from '../lib/errors';
import { requireLocalOperatorBoundary } from '../lib/local-operator-boundary';
import {
  CredentialCanaryEvidenceSchema,
  CredentialCutoverEvidenceSchema,
  CredentialRevocationEvidenceSchema,
  PostgresCredentialCeremonyStore,
  PostgresCredentialSecretStore,
  PostgresRuntimeSecretBindingAdapter,
  SupabaseCredentialCeremonyAuthority,
  SupabaseCredentialCeremonyRequestSchema,
  type CredentialCeremonySnapshot,
} from '../lib/supabase-credential-ceremony-authority';

const CeremonyIdSchema = z.string().uuid();
const SlotIdSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/);
const secureCaptureParser = express.raw({
  type: 'application/octet-stream',
  limit: '64kb',
});

export interface SupabaseCredentialCeremonyRouteService {
  readonly catalog: SupabaseCredentialCeremonyAuthority['catalog'];
  start(request: unknown): Promise<CredentialCeremonySnapshot>;
  get(ceremonyId: string): Promise<CredentialCeremonySnapshot>;
  capture(ceremonyId: string, slotId: string, material: Buffer): Promise<CredentialCeremonySnapshot>;
  verifyCanary(ceremonyId: string, evidence: unknown): Promise<CredentialCeremonySnapshot>;
  cutover(ceremonyId: string, evidence: unknown): Promise<CredentialCeremonySnapshot>;
  revokePrevious(ceremonyId: string, evidence: unknown): Promise<CredentialCeremonySnapshot>;
}

function parseRouteInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError('Credential ceremony request is invalid', {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
}

function responseView(snapshot: CredentialCeremonySnapshot): CredentialCeremonySnapshot {
  // Every nested object passed this boundary has already crossed a strict schema:
  // only metadata, SecretStore references, fingerprints, hashes, and evidence.
  return snapshot;
}

const defaultAuthority = new SupabaseCredentialCeremonyAuthority({
  store: new PostgresCredentialCeremonyStore(),
  secretStore: new PostgresCredentialSecretStore(),
  runtimeBindings: new PostgresRuntimeSecretBindingAdapter(),
});

export function requireCredentialSecureCaptureMediaType(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.is('application/octet-stream')) {
    next(new ValidationError('Secure capture requires Content-Type application/octet-stream'));
    return;
  }
  next();
}

export function createCredentialSecureCaptureHandler(
  service: SupabaseCredentialCeremonyRouteService,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const ceremonyId = parseRouteInput(CeremonyIdSchema, req.params.ceremonyId);
    const slotId = parseRouteInput(SlotIdSchema, req.params.slotId);
    if (!Buffer.isBuffer(req.body)) throw new ValidationError('Secure capture body must contain raw bytes');
    const material = req.body;
    try {
      await service.capture(ceremonyId, slotId, material);
      res.status(204).end();
    } finally {
      material.fill(0);
      req.body = undefined;
    }
  };
}

export function createSupabaseCredentialCeremonyRouter(
  service: SupabaseCredentialCeremonyRouteService = defaultAuthority,
): Router {
  const router = Router({ strict: true, caseSensitive: true });
  router.use(requireLocalOperatorBoundary);

  /**
   * @swagger
   * /api/supabase/credential-ceremonies/catalog:
   *   get:
   *     summary: List the three typed Supabase credential ceremonies
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Operator-only catalog for high-risk credential mutation capabilities; it returns classifications and receipt contracts but no values."
   *     responses:
   *       200: { description: Typed credential ceremony catalog }
   */
  router.get('/catalog', (_req: Request, res: Response) => {
    res.json({ ceremonies: service.catalog });
  });

  /**
   * @swagger
   * /api/supabase/credential-ceremonies:
   *   post:
   *     summary: Start one typed Supabase credential ceremony
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Consumes an exact local-operator credential grant bound to ceremony type, capability, scope, inventory, and request digest."
   *     responses:
   *       201: { description: Credential ceremony started }
   */
  router.post('/', async (req: Request, res: Response) => {
    const request = parseRouteInput(SupabaseCredentialCeremonyRequestSchema, req.body);
    const snapshot = await service.start(request);
    res.status(201).json({ ceremony: responseView(snapshot) });
  });

  /**
   * @swagger
   * /api/supabase/credential-ceremonies/{ceremonyId}:
   *   get:
   *     summary: Read redacted Supabase credential ceremony state or receipt
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Returns operator-only ceremony evidence, references, fingerprints, and typed receipts; captured credential bytes are structurally absent."
   *     parameters:
   *       - { in: path, name: ceremonyId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Redacted credential ceremony state }
   */
  router.get('/:ceremonyId', async (req: Request, res: Response) => {
    const ceremonyId = parseRouteInput(CeremonyIdSchema, req.params.ceremonyId);
    res.json({ ceremony: responseView(await service.get(ceremonyId)) });
  });

  /**
   * @swagger
   * /api/supabase/credential-ceremonies/{ceremonyId}/captures/{slotId}:
   *   put:
   *     summary: Capture credential bytes directly into SecretStore and runtime binding
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Dedicated local-operator binary channel; bytes bypass ordinary JSON/model surfaces, are zeroed after direct SecretStore capture, and never appear in the empty response."
   *     parameters:
   *       - { in: path, name: ceremonyId, required: true, schema: { type: string, format: uuid } }
   *       - { in: path, name: slotId, required: true, schema: { type: string } }
   *     requestBody:
   *       required: true
   *       content:
   *         application/octet-stream:
   *           schema: { type: string, format: binary }
   *     responses:
   *       204: { description: Secret captured and bound; no response body }
   */
  router.put(
    '/:ceremonyId/captures/:slotId',
    requireCredentialSecureCaptureMediaType,
    secureCaptureParser,
    createCredentialSecureCaptureHandler(service),
  );

  /**
   * @swagger
   * /api/supabase/credential-ceremonies/{ceremonyId}/canary:
   *   post:
   *     summary: Record exact replacement canary evidence
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Operator-only verification gate proving all bound consumers, or old/new JWT overlap, before credential cutover."
   *     parameters:
   *       - { in: path, name: ceremonyId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Exact canary accepted }
   */
  router.post('/:ceremonyId/canary', async (req: Request, res: Response) => {
    const ceremonyId = parseRouteInput(CeremonyIdSchema, req.params.ceremonyId);
    const evidence = parseRouteInput(CredentialCanaryEvidenceSchema, req.body);
    res.json({ ceremony: responseView(await service.verifyCanary(ceremonyId, evidence)) });
  });

  /**
   * @swagger
   * /api/supabase/credential-ceremonies/{ceremonyId}/cutover:
   *   post:
   *     summary: Promote verified standby replacements to current
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Operator-only runtime-binding cutover after exact canary evidence; does not revoke prior material."
   *     parameters:
   *       - { in: path, name: ceremonyId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Replacement bindings are current }
   */
  router.post('/:ceremonyId/cutover', async (req: Request, res: Response) => {
    const ceremonyId = parseRouteInput(CeremonyIdSchema, req.params.ceremonyId);
    const evidence = parseRouteInput(CredentialCutoverEvidenceSchema, req.body);
    res.json({ ceremony: responseView(await service.cutover(ceremonyId, evidence)) });
  });

  /**
   * @swagger
   * /api/supabase/credential-ceremonies/{ceremonyId}/revoke-previous:
   *   post:
   *     summary: Revoke the exact previous credential inventory
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Terminal high-risk transition gated by exact canary replay, elapsed grace policy, rollback readiness, complete consumer replacement, and JWT post-revocation proof when applicable."
   *     parameters:
   *       - { in: path, name: ceremonyId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Previous material revoked and typed receipt settled }
   */
  router.post('/:ceremonyId/revoke-previous', async (req: Request, res: Response) => {
    const ceremonyId = parseRouteInput(CeremonyIdSchema, req.params.ceremonyId);
    const evidence = parseRouteInput(CredentialRevocationEvidenceSchema, req.body);
    res.json({ ceremony: responseView(await service.revokePrevious(ceremonyId, evidence)) });
  });

  return router;
}

export default createSupabaseCredentialCeremonyRouter();
