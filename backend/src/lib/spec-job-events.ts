/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { getJob, isTerminalStatus, toSpecJobState, type SpecJob, type SpecJobState } from '../db/spec-jobs';
import { broadcastAll, broadcastTopic, type WalEvent } from './sse-hub';

export type SpecJobStreamEventName = 'snapshot' | 'progress' | 'terminal';

export interface SpecJobStreamEvent {
  event: SpecJobStreamEventName;
  job: SpecJobState;
}

export function specJobTopic(jobId: string): string {
  return `spec_job:${jobId}`;
}

function asWalEvent(job: SpecJob, event: SpecJobStreamEventName): WalEvent {
  return {
    id: 0,
    ts: new Date().toISOString(),
    event_type: 'spec_job_progress',
    workspace_id: job.workspaceId,
    spec_id: job.specId,
    story_id: null,
    actor: 'system',
    payload: JSON.stringify({
      event,
      jobId: job.id,
      jobType: job.jobType,
      status: job.status,
      progress: {
        current: job.progressCurrent,
        total: job.progressTotal,
        message: job.progressMessage,
      },
    }),
  };
}

export async function publishSpecJobSnapshot(
  jobId: string,
  forcedEvent?: SpecJobStreamEventName,
): Promise<SpecJobState | null> {
  const job = await getJob(jobId);
  if (!job) {
    return null;
  }

  const event = forcedEvent ?? (isTerminalStatus(job.status) ? 'terminal' : 'progress');
  const snapshot = toSpecJobState(job);
  broadcastTopic(specJobTopic(jobId), { event, job: snapshot } satisfies SpecJobStreamEvent);
  broadcastAll(asWalEvent(job, event));
  return snapshot;
}
