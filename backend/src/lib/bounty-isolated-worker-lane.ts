/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Separate pg-boss lane for one-shot, proposal-only bounty workers.
 */
import type PgBoss from 'pg-boss';
import { z } from 'zod';
import { BountyFeatureDisabledError, resolveBountyFeaturePolicy, type BountyFeaturePolicy } from './bounty-feature-policy';
import { ForbiddenError } from './errors';
import {
  launchIsolatedBountyWorker,
  type BountyWorkerProposal,
  type IsolatedRuntimeConfig,
} from './bounty-isolated-runtime';

export const BOUNTY_ISOLATED_PROPOSAL_QUEUE = 'bounty:isolated-proposal' as const;
const HASH_SCHEMA = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const BountyIsolatedProposalJobSchema = z.object({
  version: z.literal('bounty-isolated-job.v1'),
  outboxId: z.string().uuid(),
  workspaceId: z.string().min(1).max(256),
  missionId: z.string().uuid(),
  workPackageId: z.string().uuid(),
  routePackageHash: HASH_SCHEMA,
  contractRevision: z.number().int().positive(),
  missionEpoch: z.number().int().positive(),
}).strict();
export type BountyIsolatedProposalJob = z.infer<typeof BountyIsolatedProposalJobSchema>;

export interface IsolatedBountyAssignment {
  packagePath: string;
  runtime: IsolatedRuntimeConfig;
}

export interface IsolatedBountyLaneOptions {
  boss: PgBoss;
  policy: BountyFeaturePolicy;
  resolvePolicy?: () => Promise<BountyFeaturePolicy>;
  resolveAssignment(job: BountyIsolatedProposalJob): Promise<IsolatedBountyAssignment>;
  persistProposal(job: BountyIsolatedProposalJob, proposal: BountyWorkerProposal): Promise<void>;
  launch?: typeof launchIsolatedBountyWorker;
}

/**
 * Register only in the dedicated bounty process after operator policy passes.
 * Jobs carry authority identities/hashes only; trusted code resolves all host paths.
 * Every delivery invokes a new bwrap process and therefore a fresh model context.
 */
export async function registerIsolatedBountyProposalLane(options: IsolatedBountyLaneOptions): Promise<string> {
  if (!options.policy.enabled) throw new BountyFeatureDisabledError();
  await options.boss.createQueue(BOUNTY_ISOLATED_PROPOSAL_QUEUE);
  const launch = options.launch ?? launchIsolatedBountyWorker;
  return options.boss.work<unknown>(BOUNTY_ISOLATED_PROPOSAL_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const delivery of jobs) {
      const effectivePolicy = await (options.resolvePolicy ?? resolveBountyFeaturePolicy)();
      if (!effectivePolicy.enabled) throw new BountyFeatureDisabledError();
      const job = BountyIsolatedProposalJobSchema.parse(delivery.data);
      const assignment = await options.resolveAssignment(job);
      if (assignment.runtime.expectedMissionId !== job.missionId ||
          assignment.runtime.expectedWorkPackageId !== job.workPackageId ||
          assignment.runtime.expectedRoutePackageHash !== job.routePackageHash ||
          assignment.runtime.expectedAuthorityEpoch !== job.missionEpoch) {
        throw new ForbiddenError('resolved runtime does not match dispatched bounty authority');
      }
      const proposal = await launch(assignment.packagePath, assignment.runtime);
      await options.persistProposal(job, proposal);
    }
  });
}
