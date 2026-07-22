/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { UnprocessableError } from './errors';

/**
 * Canonical Release-1 product boundary from Linear ROR-21.
 *
 * This is deliberately data, not environment-driven configuration. A request,
 * database row, provider response, or deployment setting cannot turn a disabled
 * capability on. Production call sites use this profile as a fail-closed gate;
 * external human/provider actions remain outside Rorca authority.
 */

export type ReleaseOneCapabilityState = 'required' | 'disabled' | 'human_only';
export type ReleaseOneCapabilityEnforcement =
  | 'runtime_required'
  | 'fail_closed'
  | 'external_human_authority';

export interface ReleaseOneCapability {
  id: string;
  state: ReleaseOneCapabilityState;
  enforcement: ReleaseOneCapabilityEnforcement;
  authority: string;
  description: string;
  releaseEvidence: readonly string[];
}

function required(
  id: string,
  authority: string,
  description: string,
  releaseEvidence: readonly string[],
): ReleaseOneCapability {
  return Object.freeze({ id, state: 'required', enforcement: 'runtime_required', authority, description, releaseEvidence });
}

function disabled(id: string, description: string, releaseEvidence: readonly string[]): ReleaseOneCapability {
  return Object.freeze({
    id,
    state: 'disabled',
    enforcement: 'fail_closed',
    authority: 'No Release-1 actor has this authority',
    description,
    releaseEvidence,
  });
}

function humanOnly(id: string, authority: string, description: string): ReleaseOneCapability {
  return Object.freeze({
    id,
    state: 'human_only',
    enforcement: 'external_human_authority',
    authority,
    description,
    releaseEvidence: Object.freeze(['Exact-SHA publication bundle stops before this boundary']),
  });
}

const capabilities = [
  required(
    'platform_integrity',
    'Rorca host under verified local-admin/service boundaries',
    'Type, database, migration, queue, API, security, build, and test foundations used by every supervised flow.',
    ['Exact-current broad and focused gates are green', 'No hidden, waived, or cross-suite-corrupted failure'],
  ),
  required(
    'authorized_spec_authoring',
    'Local/platform admin or explicitly routed Hermes workflow',
    'An authorized brief becomes one canonical spec with durable authoring and approval identities.',
    ['Spec persistence and approval crash recovery', 'Exact request/response identity'],
  ),
  required(
    'approved_context_evidence',
    'Human-approved knowledge plus bounded host retrieval',
    'Direction, context, and evidence used by a run retain provenance and approved-only boundaries.',
    ['Context and graph scope tests', 'Evidence provenance and redaction tests'],
  ),
  required(
    'provider_human_approval',
    'Distinct provider-authenticated human approver',
    'A provider-human decision is exact-target, tenant/thread/message bound, signed, one-use, and replay fenced.',
    ['Hermes lifecycle ChatOps cross-service certification', 'Rorca one-use receipt tests'],
  ),
  required(
    'bounded_task_manifest',
    'Hermes supervisory relay plus Rorca host validation',
    'Execution starts only from a behaviorally identical, identity-bound TaskManifest with frozen scope and options.',
    ['Hermes/Rorca schema contract', 'HTTP to application outbox to pg-boss to worker certification'],
  ),
  required(
    'isolated_worktree_execution',
    'Rorca host',
    'The host creates and owns an isolated worktree and branch before any implementation process starts.',
    ['Distinct-worktree Git integration', 'No protected-checkout mutation'],
  ),
  required(
    'host_enforced_scope',
    'Rorca host',
    'Path, command, process, sandbox, credential, and Git lineage limits are enforced by the host rather than prompts.',
    ['Symlink/path/command adversaries', 'Base-to-terminal Git inventory'],
  ),
  required(
    'trusted_validation_closeout',
    'Rorca host using application-owned state',
    'Tests and immutable host evidence terminalize the run before any public release result is projected.',
    ['Cancellation and duplicate-delivery fences', 'Trusted closeout and restart reconciliation'],
  ),
  required(
    'github_app_draft_pr_check',
    'Bound GitHub App installation after human setup',
    'Release-1 delivery is a GitHub App draft PR plus Check Run bound to the exact repository, base, head, and evidence.',
    ['No-send provider contract tests', 'Exact-repository draft-PR and Check Run certification'],
  ),
  required(
    'human_merge_observation',
    'Rorca observes signed provider evidence; it does not merge',
    'A human review/merge may be observed and learned from without granting Rorca provider merge authority.',
    ['Signed webhook identity', 'Merged-SHA observation is append-only and non-actuating'],
  ),
  required(
    'learning_memory',
    'Human review boundary plus Rorca memory ledger',
    'Closeout lessons enter reviewable memory with provenance; unsafe candidates never become durable implicitly.',
    ['Candidate review gates', 'Memory provenance and graph projection tests'],
  ),
  required(
    'supervised_retry',
    'Local admin or exact provider-human retry approval',
    'A bounded failed story may be retried from frozen application truth without broadening its authority.',
    ['Governed retry preview/dispatch', 'Smallest-scope retry and replay tests'],
  ),
  required(
    'operator_diagnostics',
    'Local/platform admin read authority',
    'Read-only health, evidence, cost, PTY, and audit surfaces remain truthful and workspace scoped.',
    ['OpenAPI/tier parity', 'Workspace and operator authorization tests'],
  ),
  required(
    'mcp_local_automation',
    'Tiered local MCP caller',
    'The supported local automation surface exactly mirrors documented API authority and defaults denied.',
    ['MCP/OpenAPI parity', 'Native-route exclusion and tier tests'],
  ),

  disabled(
    'deployment_promotion',
    'Environment or deployment promotion is outside Release-1 and must reject before provider or credential effects.',
    ['Production fail-closed route/worker test'],
  ),
  disabled(
    'autonomous_provider_merge',
    'Rorca, Hermes, workers, and models cannot invoke a provider merge in Release-1.',
    ['Provider merge actuator unreachable under Release-1 profile'],
  ),
  disabled('auto_merge', 'No run or delivery request may enable auto-merge.', ['Request and persisted-option rejection tests']),
  disabled(
    'protected_branch_direct_update',
    'Direct updates to a protected/default branch are forbidden.',
    ['Host Git boundary and provider request denial'],
  ),
  disabled(
    'branch_only_external_push',
    'Reviewed work cannot be silently downgraded from PR/draft-PR to an external branch push.',
    ['Exact merge-strategy preservation tests'],
  ),
  disabled(
    'unattended_control_plane_mutation',
    'Policy, credential, GitHub App, ingress, channel, and equivalent control-plane changes require a human outside the runner.',
    ['Native local-admin/service-denial tests', 'No ambient provider mutation'],
  ),
  disabled(
    'ambient_credential_injection',
    'Ambient vault, shell, Git, SSH, gh, and provider credentials cannot be copied into implementation execution.',
    ['Token-last and credential-copy denial tests'],
  ),
  disabled(
    'scheduled_autonomy',
    'Scheduled unattended implementation or delivery is unsupported in Release-1.',
    ['Trigger-type fail-closed test'],
  ),
  disabled(
    'repair_autonomy',
    'Automated repair may diagnose or draft a bounded proposal but cannot dispatch unattended execution in Release-1.',
    ['Repair-dispatch fail-closed test'],
  ),
  disabled(
    'high_risk_parallel_autonomy',
    'Wave-parallel and high/critical-risk autonomous execution are not Release-1 capabilities.',
    ['Wave/high-risk pre-spawn denial tests'],
  ),
  disabled(
    'local_user_execution_bridge',
    'The retired local-user transport cannot execute Release-1 TaskManifests.',
    ['Execution-environment denial and no-fallback tests'],
  ),
  disabled(
    'warm_shared_agent_server',
    'A shared warm agent control socket cannot cross isolated execution namespaces safely.',
    ['Warm-server start fails closed; per-request sandbox path remains tested'],
  ),
  disabled(
    'manual_worktree_merge_surface',
    'Legacy manual worktree merge/retry endpoints cannot bypass exact draft-PR release authority.',
    ['Legacy endpoint conflict tests with no Git or provider effect'],
  ),

  humanOnly(
    'github_app_installation',
    'Repository owner/provider administrator',
    'App installation, repository selection, permissions, secrets, and webhook ingress are human/provider-controlled.',
  ),
  humanOnly(
    'implementation_publication',
    'Human release operator with repository/provider authority',
    'Publishing this Rorca implementation—push, tag, pull request, provider check, merge, or deployment—occurs only after the exact certification bundle is reviewed. This boundary does not disable the separately authorized product runtime that creates a bound draft PR and Check Run.',
  ),
  humanOnly(
    'human_review_merge',
    'Repository reviewer/merger',
    'Pull-request review and merge remain a distinct human decision; Rorca may only observe the signed result.',
  ),
] as const;

export const RELEASE_ONE_CAPABILITY_PROFILE = Object.freeze({
  schemaVersion: 'rorca.release-one-capabilities.v1' as const,
  profileId: 'release-1-supervised-core' as const,
  roadmapAuthority: 'Linear ROR-21' as const,
  mode: 'supervised' as const,
  capabilities: Object.freeze(capabilities),
  invariants: Object.freeze([
    'Rorca application state is canonical; pg-boss is dispatch only; Hermes is supervisory only.',
    'No disabled capability can be enabled by request, environment, database state, model output, or provider response.',
    'Every implementation process starts in a host-created isolated worktree with frozen bounded authority.',
    'Public completion follows trusted semantic closeout and never grants merge or deployment authority.',
    'The release bundle stops before every provider-, publication-, installation-, and human-controlled action.',
  ]),
});

const capabilityById = new Map<string, ReleaseOneCapability>(
  RELEASE_ONE_CAPABILITY_PROFILE.capabilities.map((capability) => [capability.id, capability]),
);

export function getReleaseOneCapability(id: string): ReleaseOneCapability {
  const capability = capabilityById.get(id);
  if (!capability) throw new Error(`Unknown Release-1 capability: ${id}`);
  return capability;
}

export function isReleaseOneCapabilityEnabled(id: string): boolean {
  return getReleaseOneCapability(id).state === 'required';
}

export interface ReleaseOnePipelineExecutionRequest {
  dryRun?: boolean;
  triggerType?: 'manual' | 'scheduled';
  orchestrationMode?: 'sequential' | 'wave-parallel';
  parallelism?: number;
  autoWorktree?: boolean;
  autoMerge?: boolean;
  mergeStrategy?: 'direct' | 'pr' | 'draft-pr' | 'branch-only';
  executionEnvironment?: 'remote-rorca' | 'local-user';
  taskManifestAuthority?: boolean;
}

/** Validate the Release-1 execution envelope before workspace, run, Git, or queue mutation. */
export function assertReleaseOnePipelineExecutionRequest(input: ReleaseOnePipelineExecutionRequest): void {
  if (input.dryRun === true) return;
  if (input.triggerType === 'scheduled') {
    assertReleaseOneCapabilityEnabled('scheduled_autonomy', { triggerType: input.triggerType });
  }
  if (input.orchestrationMode === 'wave-parallel' || Number(input.parallelism ?? 1) > 1) {
    assertReleaseOneCapabilityEnabled('high_risk_parallel_autonomy', {
      orchestrationMode: input.orchestrationMode ?? 'sequential',
      parallelism: input.parallelism ?? 1,
    });
  }
  if (input.executionEnvironment === 'local-user') {
    assertReleaseOneCapabilityEnabled('local_user_execution_bridge', { executionEnvironment: input.executionEnvironment });
  }
  if (input.autoMerge === true) {
    assertReleaseOneCapabilityEnabled('auto_merge', { autoMerge: true });
  }
  if (input.autoWorktree !== true || (input.mergeStrategy ?? 'direct') === 'direct') {
    assertReleaseOneCapabilityEnabled('protected_branch_direct_update', {
      autoWorktree: input.autoWorktree ?? false,
      mergeStrategy: input.mergeStrategy ?? 'direct',
    });
  }
  if (input.mergeStrategy === 'branch-only') {
    assertReleaseOneCapabilityEnabled('branch_only_external_push', { mergeStrategy: input.mergeStrategy });
  }
  if (input.taskManifestAuthority !== true) {
    throw new UnprocessableError(
      'Release-1 execution requires a host-validated bounded TaskManifest; use /api/pipeline/task-manifests/trigger',
      'RELEASE_ONE_TASK_MANIFEST_REQUIRED',
      {
        profileId: RELEASE_ONE_CAPABILITY_PROFILE.profileId,
        capabilityId: 'bounded_task_manifest',
        endpoint: '/api/pipeline/task-manifests/trigger',
      },
    );
  }
}

/** Reject a disabled or human-only capability before any durable or external effect. */
export function assertReleaseOneCapabilityEnabled(
  id: string,
  context: Record<string, unknown> = {},
): void {
  const capability = getReleaseOneCapability(id);
  if (capability.state === 'required') return;
  const humanBoundary = capability.state === 'human_only';
  throw new UnprocessableError(
    humanBoundary
      ? `Release-1 requires external human authority for capability '${id}'`
      : `Release-1 capability '${id}' is disabled and cannot be enabled by request or runtime state`,
    humanBoundary ? 'RELEASE_ONE_HUMAN_AUTHORITY_REQUIRED' : 'RELEASE_ONE_CAPABILITY_DISABLED',
    {
      profileId: RELEASE_ONE_CAPABILITY_PROFILE.profileId,
      capabilityId: id,
      capabilityState: capability.state,
      enforcement: capability.enforcement,
      ...context,
    },
  );
}
