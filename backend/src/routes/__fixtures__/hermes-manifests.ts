/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Hermes compatibility fixtures for the Rorca task-manifest bridge.
 *
 * Worktree provenance for this contract:
 * - hermes-closed-loop/PR#7: HRC shared-context/repair concepts including route decisions,
 *   shared context refs, selected skills/principles, validation gates, evidence ids, branchStrategy,
 *   branchName/worktreePath/baseBranch/baseHead, and source Rorca spec/run/story refs.
 * - rorca-exec-env-toggle: optional executionEnvironment/executionEnvironmentId fields that are
 *   present only when that active worktree's execution-environment support is installed.
 *
 * These fixtures are standalone test data. They intentionally do not import Hermes, call a live
 * Rorca API, require a Hermes checkout, or require GitHub/Linear/Slack credentials/provider CLIs.
 */

export const HERMES_FIXTURE_PROVENANCE = [
  'hermes-closed-loop/PR#7',
  'rorca-exec-env-toggle',
] as const;

const hrcContextRefs = [
  {
    kind: 'artifact',
    ref: 'hrc-shared-context:bundle-20260315T220000Z',
    path: 'hermes/hrc/shared-context/bundle.json',
    title: 'HRC shared context bundle',
    digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    excerpt: 'Shared context bundle references the repair plan, readiness verdict, and selected bounded evidence ids.',
  },
  {
    kind: 'trace',
    ref: 'route-decision:repair-dispatcher/pr-only',
    path: 'hermes/hrc/route-decision.json',
    title: 'Repair dispatcher route decision',
    digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  },
  {
    kind: 'memory',
    ref: 'selected-skill:rorca-autonomous-runner',
    title: 'Selected Hermes skill',
    excerpt: 'Hermes selected the Rorca autonomous runner skill for bounded implementation under the bridge.',
  },
  {
    kind: 'memory',
    ref: 'selected-principle:branch-pr-only',
    title: 'Selected safety principle',
    excerpt: 'HRC selected the branch/PR-only principle: no direct merge, no deploys, no credential copying.',
  },
  {
    kind: 'artifact',
    ref: 'validation-gate:gate-hrc-008',
    path: 'hermes/hrc/validation-gate.json',
    title: 'Validation gate from direct-repair-readiness',
    digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  },
] as const;

const hrcEvidence = [
  {
    kind: 'trace',
    ref: 'evidence:ev-route-decision-001',
    path: 'hermes/hrc/evidence/route-decision.json',
    digest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    summary: 'Repair dispatcher selected the task-manifest route instead of legacy direct repair.',
  },
  {
    kind: 'validation',
    ref: 'evidence:ev-validation-gate-002',
    path: 'hermes/hrc/evidence/validation-gate.json',
    digest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
    summary: 'Validation gate requires lint, typecheck, and route regression tests before PR review.',
  },
  {
    kind: 'pr',
    ref: 'evidence:ev-branch-policy-003',
    path: 'hermes/hrc/evidence/branch-policy.json',
    digest: 'sha256:6666666666666666666666666666666666666666666666666666666666666666',
    summary: 'Branch strategy is PR-only; auto merge and direct merge are prohibited.',
  },
] as const;

export const hermesHrcTaskManifestWithExecutionEnvironment = {
  manifestVersion: 1,
  manifestId: '33333333-3333-4333-8333-333333333333',
  idempotencyKey: '44444444-4444-4444-8444-444444444444',
  workspaceId: 'ws-hermes',
  source: {
    rorca: {
      specId: 'rorca-task-manifest-execution-bridge-for-hermes',
      runId: '20260316000440',
      storyId: 'TMB-008',
      specPath: 'forge/specs/approved/rorca-task-manifest-execution-bridge-for-hermes.json',
    },
    github: {
      owner: 'hermes-ai',
      repo: 'hermes',
      pullRequestNumber: 7,
      pullRequestUrl: 'https://github.example/hermes-ai/hermes/pull/7',
      headSha: 'abcdef1234567890',
    },
    linear: {
      issueId: 'HRC-008',
      issueKey: 'HRC-008',
      issueUrl: 'https://linear.example/hermes/issue/HRC-008',
    },
    slack: {
      channelId: 'C0HERMESHRC',
      threadTs: '1770000000.000800',
      messageTs: '1770000001.000800',
      threadUrl: 'https://slack.example/archives/C0HERMESHRC/p1770000000000800',
    },
    operator: {
      intentId: 'hrc-repair-intent-008',
      actor: 'hermes-closed-loop',
      summary: 'Dispatch a bounded HRC repair through Rorca with PR-only review and retained source refs.',
    },
  },
  routeDecision: {
    route: 'hermes.hrc.task-manifest',
    reason: 'HRC direct-repair readiness selected the Rorca task-manifest bridge so Rorca owns execution policy and durable run state.',
    confidence: 0.97,
    decidedAt: '2026-03-16T00:08:00.000Z',
  },
  objective: 'Execute a bounded Hermes HRC repair through the Rorca task-manifest bridge while preserving shared context and evidence provenance.',
  boundedScope: {
    summary: 'Bridge-only repair scope derived from HRC shared context. Modify only bridge tests, fixtures, and validation glue.',
    allowedPaths: [
      'backend/src/routes/pipeline.ts',
      'backend/src/routes/__tests__/pipeline-hermes-manifest-bridge.test.ts',
      'backend/src/routes/__fixtures__/hermes-manifests.ts',
    ],
    forbiddenPaths: [
      'src/runtime/shared-context-bundle.ts',
      'src/clients/rorca.ts',
      '.env',
    ],
    inScope: [
      'Validate Hermes task manifests at the Rorca route boundary',
      'Preserve selected skills and principles as bounded refs',
      'Require branch/PR-only execution policy',
    ],
    outOfScope: [
      'Import Hermes runtime code',
      'Create live GitHub/Linear/Slack side effects',
      'Run provider CLIs during route tests',
    ],
  },
  tasks: [
    {
      taskId: 'TMB-008-HRC-route-contract',
      title: 'Add Hermes HRC manifest route regression coverage',
      description: 'Prove the route bridge accepts HRC-derived manifests and rejects legacy or unsafe repair metadata.',
      acceptanceCriteria: [
        'Fixture includes route decision, shared context refs, selected skills/principles, validation gate, evidence ids, branch/PR-only policy, and Rorca source refs',
        'Route tests pass without live Hermes, Rorca, GitHub, Linear, Slack, database, or provider CLI dependencies',
      ],
      targetPaths: [
        'backend/src/routes/pipeline.ts',
        'backend/src/routes/__tests__/pipeline-hermes-manifest-bridge.test.ts',
      ],
      commands: [
        'cd backend && npx tsc --noEmit',
      ],
      dependsOn: [],
    },
  ],
  context: {
    summary: 'HRC shared context bundle selected rorca-autonomous-runner plus branch-pr-only and evidence-bounded-repair principles. Raw prompt bundles stay in Hermes; Rorca receives refs only.',
    contextRefs: hrcContextRefs,
    tasksMdProjection: {
      path: 'tasks.md',
      generatedFrom: 'manifest',
      durableSourceOfTruth: false,
      note: 'tasks.md is a readable projection only; manifest.json remains the durable execution contract.',
    },
  },
  policy: {
    dryRun: false,
    branchPrOnly: true,
    autoMerge: false,
    deploysAllowed: false,
    credentialCopyingAllowed: false,
    commandDenylist: ['git push --force', 'terraform apply', 'kubectl apply'],
    requiredValidation: ['lint', 'typecheck', 'route-regression-tests'],
  },
  execution: {
    agentOverride: 'pi',
    modelOverride: 'claude-sonnet-4-5-20250929',
    effortLevel: 'high',
    terminalMode: 'ansi-html',
    mergeStrategy: 'draft-pr',
    executionEnvironment: 'local-worktree',
    executionEnvironmentId: 'hrc-local-worktree',
  },
  validation: {
    requiredCommands: [
      'cd backend && npx tsc --noEmit',
      'cd backend && npx jest --runInBand backend/src/routes/__tests__/pipeline-hermes-manifest-bridge.test.ts',
    ],
    successCriteria: [
      'validationGate=gate-hrc-008 passes lint and typecheck',
      'evidenceIds ev-route-decision-001, ev-validation-gate-002, and ev-branch-policy-003 remain referenced',
      'branchStrategy=pr-only remains enforced with autoMerge=false',
    ],
    artifactRefs: [
      {
        kind: 'artifact',
        ref: 'validation-gate:gate-hrc-008',
        path: 'hermes/hrc/validation-gate.json',
        digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
      },
    ],
  },
  evidence: hrcEvidence,
  createdAt: '2026-03-16T00:08:00.000Z',
} as const;

export const hermesHrcTaskManifestWithoutExecutionEnvironment = {
  ...hermesHrcTaskManifestWithExecutionEnvironment,
  manifestId: '55555555-5555-4555-8555-555555555555',
  idempotencyKey: '66666666-6666-4666-8666-666666666666',
  execution: {
    agentOverride: 'pi',
    modelOverride: 'claude-sonnet-4-5-20250929',
    effortLevel: 'high',
    terminalMode: 'ansi-html',
    mergeStrategy: 'branch-only',
  },
} as const;

export const legacyHermesRepairTriggerMetadata = {
  specPath: 'forge/specs/approved/rorca-task-manifest-execution-bridge-for-hermes.json',
  workspaceId: 'ws-hermes',
  repairPlanId: 'repair-plan-hrc-008',
  evidenceIds: ['ev-route-decision-001', 'ev-validation-gate-002', 'ev-branch-policy-003'],
  validationGate: {
    id: 'gate-hrc-008',
    requiredCommands: ['cd backend && npx tsc --noEmit'],
    successCriteria: ['PR-only repair route remains enforced'],
  },
  principleSelection: {
    selectedSkills: ['rorca-autonomous-runner', 'direct-repair-readiness'],
    selectedPrinciples: ['branch-pr-only', 'evidence-bounded-repair'],
  },
  principlePromptBundles: [
    { id: 'principle-branch-pr-only', ref: 'hermes/hrc/principles/branch-pr-only.md' },
  ],
  branchStrategy: 'pr-only',
  branchName: 'feat/hrc-task-manifest-bridge',
  worktreePath: '../dirty-hermes-worktree',
  baseBranch: 'main',
  baseHead: 'abcdef1234567890',
} as const;
