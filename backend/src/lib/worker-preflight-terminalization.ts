interface FailedRunRow { workspace_id: string }

export interface FreshPreflightTerminalizationDependencies {
  bindFailure: (runId: number, reason: string) => Promise<FailedRunRow | undefined>;
  recordFailureAuthority: (runId: number, workspaceId: string, reason: string) => Promise<void>;
  transition: (runId: number, state: 'failed', detail: Record<string, unknown>) => Promise<boolean>;
  persistCloseout: (runId: number) => Promise<unknown>;
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
  await dependencies.recordFailureAuthority(runId, failed.workspace_id, reason);
  const transitioned = await dependencies.transition(runId, 'failed', {
    owner: 'worker', process: 'fresh_run_preflight', reason,
  });
  if (!transitioned) throw new Error(`Fresh pipeline run ${runId} lifecycle transition was refused`);
  await dependencies.persistCloseout(runId);
  await dependencies.advance(String(failed.workspace_id));
}
