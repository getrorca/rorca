import {
  classifyFailure,
  FAILURE_REASONS,
  type FailureReason,
  type FailureClassification,
} from '../failure-classifier';

describe('failure-classifier', () => {
  // ── FAILURE_REASONS enum completeness ───────────────────────────────

  test('FAILURE_REASONS contains at least 17 entries', () => {
    expect(FAILURE_REASONS.length).toBeGreaterThanOrEqual(17);
  });

  test('FAILURE_REASONS includes all required reasons', () => {
    const required: FailureReason[] = [
      'merge_conflict', 'auto_resolution_failed', 'agent_timeout',
      'agent_rate_limit', 'agent_socket_error', 'agent_tool_transient',
      'worktree_create_failed_existing', 'worktree_create_failed_transient',
      'wrong_api_key', 'model_not_found', 'invalid_spec', 'agent_missing',
      'gate_failure_after_max_retries', 'disk_full', 'permission_denied',
      'max_retries', 'unknown',
    ];
    for (const reason of required) {
      expect(FAILURE_REASONS).toContain(reason);
    }
  });

  // ── Transient reasons ─────────────────────────────────────────────

  test('merge_conflict → transient', () => {
    const result = classifyFailure('merge_conflict', 1, '');
    expect(result.recoveryClass).toBe('transient');
    expect(result.retryable).toBe(true);
  });

  test('auto_resolution_failed → transient', () => {
    const result = classifyFailure('auto_resolution_failed', 1, '');
    expect(result.recoveryClass).toBe('transient');
    expect(result.retryable).toBe(true);
  });

  test('agent_timeout → transient regardless of retries', () => {
    const result = classifyFailure('agent_timeout', 124, '');
    expect(result.recoveryClass).toBe('transient');
    expect(result.retryable).toBe(true);
  });

  test('agent_rate_limit → transient', () => {
    const result = classifyFailure('agent_rate_limit', 1, '');
    expect(result.recoveryClass).toBe('transient');
    expect(result.retryable).toBe(true);
  });

  test('agent_socket_error → transient', () => {
    const result = classifyFailure('agent_socket_error', 1, '');
    expect(result.recoveryClass).toBe('transient');
    expect(result.retryable).toBe(true);
  });

  test('agent_tool_transient → transient', () => {
    const result = classifyFailure('agent_tool_transient', 1, '');
    expect(result.recoveryClass).toBe('transient');
    expect(result.retryable).toBe(true);
  });

  test('worktree_create_failed_existing → transient (zombie branch)', () => {
    const result = classifyFailure('worktree_create_failed_existing', 1, '');
    expect(result.recoveryClass).toBe('transient');
    expect(result.retryable).toBe(true);
  });

  test('worktree_create_failed_transient → transient by default', () => {
    const result = classifyFailure('worktree_create_failed_transient', 1, '');
    expect(result.recoveryClass).toBe('transient');
    expect(result.retryable).toBe(true);
  });

  // ── Terminal reasons ──────────────────────────────────────────────

  test('wrong_api_key → terminal', () => {
    const result = classifyFailure('wrong_api_key', 1, '');
    expect(result.recoveryClass).toBe('terminal');
    expect(result.retryable).toBe(false);
  });

  test('model_not_found → terminal', () => {
    const result = classifyFailure('model_not_found', 1, '');
    expect(result.recoveryClass).toBe('terminal');
    expect(result.retryable).toBe(false);
  });

  test('invalid_spec → terminal', () => {
    const result = classifyFailure('invalid_spec', 1, '');
    expect(result.recoveryClass).toBe('terminal');
    expect(result.retryable).toBe(false);
  });

  test('agent_missing → terminal', () => {
    const result = classifyFailure('agent_missing', 1, '');
    expect(result.recoveryClass).toBe('terminal');
    expect(result.retryable).toBe(false);
  });

  test('gate_failure_after_max_retries → terminal', () => {
    const result = classifyFailure('gate_failure_after_max_retries', 0, '');
    expect(result.recoveryClass).toBe('terminal');
    expect(result.retryable).toBe(false);
  });

  test('disk_full → terminal', () => {
    const result = classifyFailure('disk_full', 1, '');
    expect(result.recoveryClass).toBe('terminal');
    expect(result.retryable).toBe(false);
  });

  test('permission_denied → terminal', () => {
    const result = classifyFailure('permission_denied', 1, '');
    expect(result.recoveryClass).toBe('terminal');
    expect(result.retryable).toBe(false);
  });

  // ── Policy fail ───────────────────────────────────────────────────

  test('max_retries → policy_fail', () => {
    const result = classifyFailure('max_retries', 1, '', { retriesExhausted: true });
    expect(result.recoveryClass).toBe('policy_fail');
    expect(result.retryable).toBe(false);
  });

  test('max_retries without context → policy_fail (always)', () => {
    const result = classifyFailure('max_retries', 1, '');
    expect(result.recoveryClass).toBe('policy_fail');
    expect(result.retryable).toBe(false);
  });

  test('transient reason with retriesExhausted → policy_fail', () => {
    const result = classifyFailure('agent_timeout', 124, '', { retriesExhausted: true });
    expect(result.recoveryClass).toBe('policy_fail');
    expect(result.retryable).toBe(false);
  });

  test('agent_rate_limit with retriesExhausted → policy_fail', () => {
    const result = classifyFailure('agent_rate_limit', 1, '', { retriesExhausted: true });
    expect(result.recoveryClass).toBe('policy_fail');
    expect(result.retryable).toBe(false);
  });

  // ── Stderr overrides ──────────────────────────────────────────────

  test('worktree_create_failed_transient + "no space left on device" → terminal (disk full)', () => {
    const result = classifyFailure('worktree_create_failed_transient', 1, 'fatal: No space left on device');
    expect(result.recoveryClass).toBe('terminal');
    expect(result.category).toBe('disk_full');
    expect(result.retryable).toBe(false);
  });

  test('worktree_create_failed_transient + "permission denied" → terminal', () => {
    const result = classifyFailure('worktree_create_failed_transient', 1, 'error: Permission denied');
    expect(result.recoveryClass).toBe('terminal');
    expect(result.category).toBe('permission_denied');
    expect(result.retryable).toBe(false);
  });

  // ── Edge cases ────────────────────────────────────────────────────

  test('unknown reason → terminal (prevents accidental recovery)', () => {
    const result = classifyFailure('unknown', 1, '');
    expect(result.recoveryClass).toBe('terminal');
    expect(result.retryable).toBe(false);
  });

  test('unknown reason with stderr includes snippet in message', () => {
    const result = classifyFailure('unknown', 1, 'some weird error happened');
    expect(result.recoveryClass).toBe('terminal');
    expect(result.message).toContain('some weird error happened');
  });

  test('empty stderr does not crash', () => {
    const result = classifyFailure('agent_timeout', 124, '');
    expect(result.recoveryClass).toBe('transient');
    expect(result.message).toBeTruthy();
  });

  test('exitCode=0 with transient reason → retryable=false (no-op)', () => {
    const result = classifyFailure('agent_timeout', 0, '');
    expect(result.recoveryClass).toBe('transient');
    expect(result.retryable).toBe(false);
  });

  test('exitCode=0 with merge_conflict → retryable=false (no-op)', () => {
    const result = classifyFailure('merge_conflict', 0, '');
    expect(result.recoveryClass).toBe('transient');
    expect(result.retryable).toBe(false);
  });

  // ── Classification structure ──────────────────────────────────────

  test('classification always returns all 4 fields', () => {
    for (const reason of FAILURE_REASONS) {
      const result = classifyFailure(reason, 1, '');
      expect(result).toHaveProperty('recoveryClass');
      expect(result).toHaveProperty('category');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('retryable');
      expect(['transient', 'terminal', 'policy_fail']).toContain(result.recoveryClass);
      expect(typeof result.category).toBe('string');
      expect(typeof result.message).toBe('string');
      expect(typeof result.retryable).toBe('boolean');
    }
  });

  test('terminal reasons are never retryable even with retriesExhausted', () => {
    const terminalReasons: FailureReason[] = [
      'wrong_api_key', 'model_not_found', 'invalid_spec',
      'agent_missing', 'gate_failure_after_max_retries', 'disk_full', 'permission_denied',
    ];
    for (const reason of terminalReasons) {
      const result = classifyFailure(reason, 1, '', { retriesExhausted: true });
      expect(result.recoveryClass).toBe('terminal');
      expect(result.retryable).toBe(false);
    }
  });
});
