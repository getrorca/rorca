/**
 * Failure Classifier — CP-001
 *
 * Classifies execution-engine failures into a deterministic (recoveryClass, category) pair.
 * Pure function on (reason, exitCode, stderr, context) — no side effects, no DB calls.
 *
 * Recovery classes:
 *   transient   — can be recovered by re-running the story (merge conflict, timeout, rate limit, etc.)
 *   terminal    — cannot be recovered without human intervention (wrong API key, disk full, etc.)
 *   policy_fail — underlying failure was transient but within-wave MAX_RETRIES exhausted
 */

// ─── Failure Reason Enum ────────────────────────────────────────────────────

export const FAILURE_REASONS = [
  'merge_conflict',
  'auto_resolution_failed',
  'agent_timeout',
  'agent_rate_limit',
  'agent_socket_error',
  'agent_tool_transient',
  'worktree_create_failed_existing',
  'worktree_create_failed_transient',
  'wrong_api_key',
  'model_not_found',
  'invalid_spec',
  'agent_missing',
  'gate_failure_after_max_retries',
  'disk_full',
  'permission_denied',
  'max_retries',
  'unknown',
] as const;

export type FailureReason = typeof FAILURE_REASONS[number];

export type RecoveryClass = 'transient' | 'terminal' | 'policy_fail';

export interface FailureClassification {
  recoveryClass: RecoveryClass;
  category: string;
  message: string;
  retryable: boolean;
}

export interface ClassifyContext {
  retriesExhausted?: boolean;
}

// ─── Transient Reasons ──────────────────────────────────────────────────────

const TRANSIENT_REASONS = new Set<FailureReason>([
  'merge_conflict',
  'auto_resolution_failed',
  'agent_timeout',
  'agent_rate_limit',
  'agent_socket_error',
  'agent_tool_transient',
  'worktree_create_failed_existing',
  'worktree_create_failed_transient',
]);

// ─── Terminal Reasons ───────────────────────────────────────────────────────

const TERMINAL_REASONS = new Set<FailureReason>([
  'wrong_api_key',
  'model_not_found',
  'invalid_spec',
  'agent_missing',
  'gate_failure_after_max_retries',
  'disk_full',
  'permission_denied',
]);

// ─── Stderr Override Patterns ───────────────────────────────────────────────
// Some reasons that are nominally transient become terminal based on stderr content.

interface StderrOverride {
  pattern: RegExp;
  recoveryClass: RecoveryClass;
  category: string;
  message: string;
}

const STDERR_OVERRIDES: Array<{ reason: FailureReason; overrides: StderrOverride[] }> = [
  {
    reason: 'worktree_create_failed_transient',
    overrides: [
      {
        pattern: /no space left on device/i,
        recoveryClass: 'terminal',
        category: 'disk_full',
        message: 'Worktree creation failed: no disk space remaining',
      },
      {
        pattern: /permission denied/i,
        recoveryClass: 'terminal',
        category: 'permission_denied',
        message: 'Worktree creation failed: insufficient filesystem permissions',
      },
    ],
  },
  {
    reason: 'agent_socket_error',
    overrides: [
      {
        pattern: /permission denied/i,
        recoveryClass: 'terminal',
        category: 'permission_denied',
        message: 'Agent socket error: permission denied on connection',
      },
    ],
  },
];

const STDERR_OVERRIDE_MAP = new Map(STDERR_OVERRIDES.map(o => [o.reason, o.overrides]));

// ─── Category & Message Defaults ────────────────────────────────────────────

const REASON_DEFAULTS: Record<FailureReason, { category: string; message: string }> = {
  merge_conflict:                    { category: 'merge',       message: 'Merge conflict during worktree integration' },
  auto_resolution_failed:            { category: 'merge',       message: 'Automatic merge conflict resolution failed' },
  agent_timeout:                     { category: 'timeout',     message: 'Agent subprocess timed out' },
  agent_rate_limit:                  { category: 'rate_limit',  message: 'Agent rate limited by provider' },
  agent_socket_error:                { category: 'network',     message: 'Agent connection error (socket/network)' },
  agent_tool_transient:              { category: 'tool',        message: 'Agent tool call failed transiently' },
  worktree_create_failed_existing:   { category: 'worktree',    message: 'Worktree creation failed: branch already exists (zombie from prior run)' },
  worktree_create_failed_transient:  { category: 'worktree',    message: 'Worktree creation failed (transient)' },
  wrong_api_key:                     { category: 'auth',        message: 'Invalid or expired API key' },
  model_not_found:                   { category: 'config',      message: 'Requested model not found or not available' },
  invalid_spec:                      { category: 'config',      message: 'Spec JSON is invalid or malformed' },
  agent_missing:                     { category: 'config',      message: 'Agent binary not found on PATH' },
  gate_failure_after_max_retries:    { category: 'gate',        message: 'Quality gate failed after maximum retries' },
  disk_full:                         { category: 'system',      message: 'Disk full — no space left on device' },
  permission_denied:                 { category: 'system',      message: 'Permission denied on filesystem operation' },
  max_retries:                       { category: 'policy',      message: 'Maximum retries exhausted' },
  unknown:                           { category: 'unknown',     message: 'Unclassified failure' },
};

// ─── Main Classifier ────────────────────────────────────────────────────────

export function classifyFailure(
  reason: FailureReason,
  exitCode: number,
  stderr: string,
  context?: ClassifyContext,
): FailureClassification {
  // Exit code 0 with a failure reason — the story actually succeeded at the process level.
  // This is a no-op: return transient with retryable=false (nothing to retry).
  if (exitCode === 0 && TRANSIENT_REASONS.has(reason)) {
    const defaults = REASON_DEFAULTS[reason];
    return {
      recoveryClass: 'transient',
      category: defaults.category,
      message: defaults.message,
      retryable: false,
    };
  }

  // 'max_retries' is a meta-reason: the real failure was retried N times and all failed.
  // This maps to policy_fail — operator policy says "no more in-wave retries".
  if (reason === 'max_retries') {
    return {
      recoveryClass: 'policy_fail',
      category: 'policy',
      message: 'Maximum retries exhausted — operator policy prevents further in-wave retry',
      retryable: false,
    };
  }

  // Check stderr overrides — some transient reasons escalate to terminal based on stderr.
  const overrides = STDERR_OVERRIDE_MAP.get(reason);
  if (overrides) {
    for (const override of overrides) {
      if (override.pattern.test(stderr)) {
        return {
          recoveryClass: override.recoveryClass,
          category: override.category,
          message: override.message,
          retryable: override.recoveryClass === 'transient',
        };
      }
    }
  }

  // Terminal reasons — never retryable.
  if (TERMINAL_REASONS.has(reason)) {
    const defaults = REASON_DEFAULTS[reason];
    return {
      recoveryClass: 'terminal',
      category: defaults.category,
      message: defaults.message,
      retryable: false,
    };
  }

  // Transient reasons with retriesExhausted context → policy_fail.
  if (TRANSIENT_REASONS.has(reason) && context?.retriesExhausted) {
    const defaults = REASON_DEFAULTS[reason];
    return {
      recoveryClass: 'policy_fail',
      category: defaults.category,
      message: `${defaults.message} (retries exhausted)`,
      retryable: false,
    };
  }

  // Transient reasons without exhaustion → retryable.
  if (TRANSIENT_REASONS.has(reason)) {
    const defaults = REASON_DEFAULTS[reason];
    return {
      recoveryClass: 'transient',
      category: defaults.category,
      message: defaults.message,
      retryable: true,
    };
  }

  // 'unknown' reason — default to terminal to prevent accidental recovery.
  const defaults = REASON_DEFAULTS.unknown;
  return {
    recoveryClass: 'terminal',
    category: defaults.category,
    message: stderr ? `${defaults.message}: ${stderr.slice(0, 200)}` : defaults.message,
    retryable: false,
  };
}
