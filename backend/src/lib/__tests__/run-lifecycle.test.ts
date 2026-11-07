/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execute, queryOne } from '../../db/index';
import {
  attachRunPtyLifecycle,
  isTerminalRunLifecycle,
  lifecycleFromLegacyStatus,
  transitionRunLifecycle,
} from '../run-lifecycle';

const WORKSPACE_ID = 'ws-run-lifecycle-unit';

beforeEach(async () => {
  await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Run lifecycle unit', '/tmp/run-lifecycle-unit')
     ON CONFLICT (id) DO NOTHING`,
    [WORKSPACE_ID],
  );
});

describe('backend-owned run lifecycle compatibility', () => {
  test.each([
    ['queued', 'queued'],
    ['running', 'running'],
    ['done', 'finished'],
    ['failed', 'failed'],
    ['partial_failure', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)('maps legacy %s status to authoritative %s lifecycle', (legacy, lifecycle) => {
    expect(lifecycleFromLegacyStatus(legacy)).toBe(lifecycle);
  });

  it('only treats authoritative final phases as terminal', () => {
    expect(isTerminalRunLifecycle('validating')).toBe(false);
    expect(isTerminalRunLifecycle('finished')).toBe(true);
    expect(isTerminalRunLifecycle('failed')).toBe(true);
    expect(isTerminalRunLifecycle('cancelled')).toBe(true);
  });

  it('keeps run lifecycle running across sequential PTY story attachments', async () => {
    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (workspace_id, spec_path, status)
       VALUES ($1, 'forge/specs/approved/sequential-pty.json', 'queued') RETURNING id`,
      [WORKSPACE_ID],
    );
    const id = run!.id;

    await expect(transitionRunLifecycle(id, 'starting')).resolves.toBe(true);
    await expect(attachRunPtyLifecycle(id, { storyId: 'US-001' })).resolves.toBe(true);
    await expect(transitionRunLifecycle(id, 'running')).resolves.toBe(true);
    await expect(attachRunPtyLifecycle(id, { storyId: 'US-002' })).resolves.toBe(true);

    const row = await queryOne<{ lifecycle_status: string; lifecycle_diagnostics: Record<string, unknown> }>(
      'SELECT lifecycle_status, lifecycle_diagnostics FROM pipeline_runs WHERE id = $1', [id],
    );
    expect(row?.lifecycle_status).toBe('running');
    expect(row?.lifecycle_diagnostics).toEqual(expect.objectContaining({ storyId: 'US-002' }));
  });

  it('accepts the ordered PTY path and rejects backward/terminal resurrection', async () => {
    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (workspace_id, spec_path, status)
       VALUES ($1, 'forge/specs/approved/lifecycle.json', 'queued') RETURNING id`,
      [WORKSPACE_ID],
    );
    const id = run!.id;

    await expect(transitionRunLifecycle(id, 'starting', { process: 'launching' })).resolves.toBe(true);
    await expect(transitionRunLifecycle(id, 'pty_attached', { transport: 'attached' })).resolves.toBe(true);
    await expect(transitionRunLifecycle(id, 'running', { semantic: 'prompt_injected' })).resolves.toBe(true);
    await expect(transitionRunLifecycle(id, 'validating', { process: 'exited' })).resolves.toBe(true);
    await expect(transitionRunLifecycle(id, 'finished', { merge: 'passed' })).resolves.toBe(true);
    await expect(transitionRunLifecycle(id, 'running')).resolves.toBe(false);

    const row = await queryOne<{ lifecycle_status: string; lifecycle_diagnostics: Record<string, unknown> }>(
      'SELECT lifecycle_status, lifecycle_diagnostics FROM pipeline_runs WHERE id = $1', [id],
    );
    expect(row).toEqual(expect.objectContaining({ lifecycle_status: 'finished' }));
    expect(row?.lifecycle_diagnostics).toEqual(expect.objectContaining({ merge: 'passed' }));
  });
});
