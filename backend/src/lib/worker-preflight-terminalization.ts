interface FailedRunRow { workspace_id: string }

export interface FreshPreflightTerminalizationDependencies {
  bindFailure: (runId: number, reason: string) => Promise<FailedRunRow | undefined>;
  transition: (runId: number, state: 'failed', detail: Record<string, unknown>) => Promise<boolean>;
  emit: (eventType: string, workspaceId: string, payload: Record<string, unknown>) => Promise<unknown>;
  advance: (workspaceId: string) => Promise<unknown>;
}

/**
 * Fail-closed terminalization for a valid fresh-run payload rejected before
 * spawn. The job may be acknowledged only after durable run binding,
 * lifecycle transition, semantic closeout, terminal event, and queue advance.
 */
export async function terminalizeFreshRunPreflightFailure(
  runId: number,
  reason: string,
  dependencies: FreshPreflightTerminalizationDependencies,
): Promise<void> {
  const failed = await dependencies.bindFailure(runId, reason);
  if (!failed) throw new Error(`Fresh pipeline run ${runId} rejection could not be bound to a mutable durable run`);
  const transitioned = await dependencies.transition(runId, 'failed', {
    owner: 'worker', process: 'fresh_run_preflight', reason,
  });
  if (!transitioned) throw new Error(`Fresh pipeline run ${runId} lifecycle transition was refused`);
  const closeout = {
    run_id: runId, status: 'failed', reason, source: 'worker', infra_error: true, semantic_closeout: true,
  };
  await dependencies.emit('run_closeout', failed.workspace_id, closeout);
  await dependencies.emit('run_finished', failed.workspace_id, closeout);
  await dependencies.advance(String(failed.workspace_id));
}
