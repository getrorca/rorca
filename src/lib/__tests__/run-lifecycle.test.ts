import { describe, expect, it } from 'vitest';
import { applyRunLifecycleEvent, resolveRunLifecyclePhase } from '../run-lifecycle';

describe('applyRunLifecycleEvent', () => {
  it('preserves failed completion instead of rendering it as done', () => {
    expect(applyRunLifecycleEvent('running', {
      event_type: 'run_finished',
      payload: { status: 'failed' },
    })).toBe('failed');
  });

  it('accepts serialized partial-failure payloads', () => {
    expect(applyRunLifecycleEvent('running', {
      event_type: 'run_finished',
      payload: JSON.stringify({ status: 'partial_failure' }),
    })).toBe('partial_failure');
  });

  it('uses done for successful or legacy run_finished events', () => {
    expect(applyRunLifecycleEvent('running', { event_type: 'run_finished' })).toBe('done');
    expect(applyRunLifecycleEvent('running', {
      event_type: 'run_finished',
      payload: { status: 'done' },
    })).toBe('done');
  });

  it('prefers the authoritative backend lifecycle phase over a stale status', () => {
    expect(resolveRunLifecyclePhase({ status: 'running', lifecyclePhase: 'paused' })).toBe('paused');
  });

  it('uses the centralized status fallback, then applies newer WAL lifecycle events', () => {
    expect(resolveRunLifecyclePhase(
      { status: 'running' },
      [{ event_type: 'run_finished', payload: { status: 'partial_failure' } }],
    )).toBe('partial_failure');
  });
});
