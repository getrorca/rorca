/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createStoryLifecycleExecutionContract,
  type StoryLifecycleExecutionContract,
} from '../../story-execution-packet';
import type { LifecyclePlan } from '../../ssdlc-contracts';
import { EVALUATOR_PLAN } from './ssdlc-phase-evaluator.fixtures';

const SPEC_HASH = `sha256:${'2'.repeat(64)}`;

/** Exact lifecycle authority for manifest-focused tests with arbitrary identities. */
export function storyLifecycleFixture(
  workspaceId: string,
  specId: string,
  storyId: string,
  allStoryIds: readonly string[] = [storyId],
): StoryLifecycleExecutionContract {
  const plan = structuredClone(EVALUATOR_PLAN) as LifecyclePlan;
  plan.workspaceId = workspaceId;
  plan.specId = specId;
  const storyReferences = [...new Set(allStoryIds)];
  if (!storyReferences.includes(storyId)) storyReferences.push(storyId);
  plan.storyReferences = storyReferences;
  plan.requirementMappings = plan.requirementMappings.map((mapping) => {
    const storyTarget = mapping.targetReferences.find((target) => target.type === 'story');
    if (!storyTarget) return mapping;
    return {
      ...mapping,
      targetReferences: [
        ...mapping.targetReferences.filter((target) => target.type !== 'story'),
        ...storyReferences.map((reference) => ({ ...storyTarget, reference })),
      ],
    };
  });
  return createStoryLifecycleExecutionContract({
    dispatchClaim: {
      schemaVersion: 'lifecycle-dispatch-claim.v1',
      claimId: '123e4567-e89b-42d3-a456-426614174000',
      workspaceId,
      specId,
      specHash: SPEC_HASH,
      compiledPlanId: '17',
      requestIdentity: `test:${workspaceId}:${specId}`,
      requestHash: `sha256:${'9'.repeat(64)}`,
    },
    plan,
    storyId,
  });
}
