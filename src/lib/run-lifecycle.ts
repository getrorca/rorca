import { normalizeRunLifecyclePhase, type RunLifecyclePhase, type RunMetadataSource } from './run-metadata';

export type RunLifecycleStatus = RunLifecyclePhase | string;

interface LifecycleEvent {
  event_type: string;
  payload?: unknown;
}

function payloadStatus(payload: unknown): string | null {
  let value = payload;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || !('status' in value)) return null;
  const status = (value as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

/** Apply one WAL lifecycle event without conflating run_finished with success. */
export function applyRunLifecycleEvent(current: RunLifecycleStatus, event: LifecycleEvent): RunLifecycleStatus {
  switch (event.event_type) {
    case 'run_finished': {
      const status = payloadStatus(event.payload);
      return status === 'failed' || status === 'partial_failure' || status === 'cancelled'
        ? status
        : 'done';
    }
    case 'run_failed': return 'failed';
    case 'run_cancelled': return 'cancelled';
    case 'run_paused': return 'paused';
    case 'run_blocked': return 'blocked';
    case 'run_resumed':
    case 'run_started': return 'running';
    default: return current;
  }
}

/**
 * Normalize the backend-owned lifecycle. The optional event parameter remains
 * for source compatibility, but is intentionally ignored: browser WAL/output
 * can request a refresh, never advance a primary run phase.
 */
export function resolveRunLifecyclePhase(
  run: Pick<RunMetadataSource, 'lifecycleStatus' | 'lifecycle_status' | 'lifecyclePhase' | 'lifecycle_phase' | 'status'>,
  _events: LifecycleEvent[] = [],
): RunLifecycleStatus {
  return normalizeRunLifecyclePhase(run);
}
