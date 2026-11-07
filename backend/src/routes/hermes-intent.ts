/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { queryOne } from '../db/index';
import { ConflictError, ValidationError } from '../lib/errors';
import { requireHermesAction } from '../lib/hermes-authority';
import {
  deriveFrozenSourceBundleDigest,
  IntentDispositionV1Schema,
  IntentEnvelopeV1Schema,
  SOURCE_CONTRACT_VERSIONS,
  type IntentDispositionV1,
  type IntentEnvelopeV1,
} from '../lib/source-contracts';

interface ReplayEntry {
  requestHash: string;
  disposition: Promise<IntentDispositionV1>;
}

export type HermesMissionLookup = (
  missionId: string,
  workspaceId: string,
) => Promise<{ workspace_id: string } | undefined>;

async function lookupMission(missionId: string, workspaceId: string): Promise<{ workspace_id: string } | undefined> {
  return queryOne<{ workspace_id: string }>(
    'SELECT workspace_id FROM rorca.governed_missions WHERE mission_id=$1 ORDER BY workspace_id=$2 DESC LIMIT 1',
    [missionId, workspaceId],
  );
}

// Intake has no write effect. This bounded process cache prevents repeated audit/intake
// work and, critically, never triggers HMG-007's separately-authorized mutation sequence.
const replayCache = new Map<string, ReplayEntry>();
const MAX_REPLAY_ENTRIES = 10_000;

const POLICY_VIOLATION = /\b(?:bypass|disable|ignore|evade)\b.{0,40}\b(?:approval|assurance|audit|control|policy|security)\b|\b(?:steal|exfiltrate|leak)\b.{0,30}\b(?:credential|secret|token|password)s?\b/i;
const MEMORY_CANDIDATE = /\b(?:remember|save|store|capture|record)\b.{0,50}\b(?:memory|for (?:later|future)|lesson|preference)\b|\b(?:note|lesson)\s+for\s+(?:later|future)\b/i;
const READ_ONLY_QUESTION = /^\s*(?:what|why|when|where|who|which|how|is|are|can|could|do|does|did|explain|summarize|describe|show|tell)\b|\?\s*$/i;
const AMBIGUOUS_SCOPE = /\b(?:maybe|something|somehow|whatever|not sure|unclear|tbd|figure it out)\b/i;

function requestHash(envelope: IntentEnvelopeV1): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

function replayKey(workspaceId: string, idempotencyKey: string): string {
  // A structured encoding cannot collide even if a future contract permits control
  // characters in either component.
  return JSON.stringify([workspaceId, idempotencyKey]);
}

function disposition(
  _envelope: IntentEnvelopeV1,
  auditIdentity: string,
  fields: Record<string, unknown>,
): IntentDispositionV1 {
  return IntentDispositionV1Schema.parse({
    schemaVersion: SOURCE_CONTRACT_VERSIONS.intentDisposition,
    auditIdentity,
    authorityMode: 'service-audit',
    ...fields,
  });
}

async function classify(
  envelope: IntentEnvelopeV1,
  auditIdentity: string,
  missionLookup: HermesMissionLookup,
): Promise<IntentDispositionV1> {
  const base = { targetRef: null, draftHash: null, requiredDecision: null } as const;

  if (POLICY_VIOLATION.test(envelope.userIntent)) {
    return disposition(envelope, auditIdentity, {
      ...base,
      disposition: 'denied',
      permittedAction: 'deny',
      rationale: 'The request explicitly attempts to violate or bypass required security, policy, assurance, or approval controls.',
    });
  }

  if (envelope.missionRef) {
    if (envelope.missionRef.workspaceId !== envelope.workspaceRef.workspaceId) {
      return disposition(envelope, auditIdentity, {
        ...base,
        disposition: 'denied',
        permittedAction: 'deny',
        rationale: 'The referenced mission belongs to another workspace and cannot be accessed from this intent.',
      });
    }
    const mission = await missionLookup(envelope.missionRef.id, envelope.workspaceRef.workspaceId);
    if (mission?.workspace_id === envelope.workspaceRef.workspaceId) {
      return disposition(envelope, auditIdentity, {
        ...base,
        disposition: 'existing_mission_action',
        permittedAction: 'open_mission',
        targetRef: envelope.missionRef,
        rationale: 'An exact existing mission reference was supplied and verified in the requesting workspace.',
      });
    }
    if (mission) {
      return disposition(envelope, auditIdentity, {
        ...base,
        disposition: 'denied',
        permittedAction: 'deny',
        rationale: 'A mission with this id exists only in another workspace; cross-workspace mission access is denied.',
      });
    }
    return disposition(envelope, auditIdentity, {
      ...base,
      disposition: 'clarification_required',
      permittedAction: 'request_clarification',
      rationale: 'The referenced mission does not exist in the requesting workspace.',
      requiredDecision: 'Provide an existing mission reference in this workspace or remove the mission reference.',
    });
  }

  if (envelope.sourceBundle) {
    return disposition(envelope, auditIdentity, {
      ...base,
      disposition: 'mission_draft',
      permittedAction: 'draft_mission',
      draftHash: envelope.sourceBundle.bundleHash,
      frozenBundleDigest: deriveFrozenSourceBundleDigest(envelope.sourceBundle),
      rationale: 'Explicit source references were compiled into a verified bundle; only a mission draft is permitted pending the HMG-007 review and approval sequence.',
    });
  }

  if (MEMORY_CANDIDATE.test(envelope.userIntent)) {
    return disposition(envelope, auditIdentity, {
      ...base,
      disposition: 'memory_candidate',
      permittedAction: 'propose_memory',
      rationale: 'The request explicitly asks to retain a lesson, preference, or fact for future use; it is proposed rather than stored automatically.',
    });
  }

  if (READ_ONLY_QUESTION.test(envelope.userIntent) && !AMBIGUOUS_SCOPE.test(envelope.userIntent)) {
    return disposition(envelope, auditIdentity, {
      ...base,
      disposition: 'answer',
      permittedAction: 'answer',
      rationale: 'The request is a bounded read-only question with no mission, source, memory, or mutation signal.',
    });
  }

  return disposition(envelope, auditIdentity, {
    ...base,
    disposition: 'clarification_required',
    permittedAction: 'request_clarification',
    rationale: 'The request does not identify a bounded read-only question, exact mission, or explicit source scope.',
    requiredDecision: 'Clarify whether to ask a read-only question, act on a named mission, or draft from explicit sources.',
  });
}

/**
 * @swagger
 * /api/hermes/intent:
 *   post:
 *     summary: Classify a Hermes intent without executing it
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace-scoped service-audit intake is MCP-callable but cannot persist or trigger a mission."
 *     responses:
 *       200: { description: Strict IntentDispositionV1 classification }
 *       400: { description: Invalid intent envelope or authority declaration }
 *       403: { description: Missing or elevated Hermes authority }
 *       409: { description: Idempotency key reused with a different request }
 */
export function createHermesIntentRouter(missionLookup: HermesMissionLookup = lookupMission): Router {
  const router = Router();
  router.post('/', async (req: Request, res: Response) => {
    requireHermesAction(req.hermesAuthority, 'intent', 'service-audit');
    const parsed = IntentEnvelopeV1Schema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid IntentEnvelopeV1', { issues: parsed.error.issues });
    }
    const envelope = parsed.data;
    const cacheKey = replayKey(envelope.workspaceRef.workspaceId, envelope.idempotencyKey);
    const hash = requestHash(envelope);
    const replay = replayCache.get(cacheKey);
    if (replay) {
      if (replay.requestHash !== hash) {
        throw new ConflictError('idempotencyKey was already used for a different intent in this workspace');
      }
      res.json(await replay.disposition);
      return;
    }

    // Install the promise before classification starts so simultaneous deliveries share
    // the mission lookup and cannot duplicate future intake-side audit work.
    const pendingDisposition = classify(envelope, req.hermesAuthority!.auditIdentity, missionLookup);
    if (replayCache.size >= MAX_REPLAY_ENTRIES) replayCache.delete(replayCache.keys().next().value!);
    replayCache.set(cacheKey, { requestHash: hash, disposition: pendingDisposition });
    try {
      res.json(await pendingDisposition);
    } catch (error) {
      // Failed attempts are retryable; remove only this attempt in case a test reset or
      // later request replaced the entry while classification was pending.
      if (replayCache.get(cacheKey)?.disposition === pendingDisposition) replayCache.delete(cacheKey);
      throw error;
    }
  });
  return router;
}

const router = createHermesIntentRouter();

export function resetHermesIntentReplayCacheForTests(): void {
  replayCache.clear();
}

export default router;
