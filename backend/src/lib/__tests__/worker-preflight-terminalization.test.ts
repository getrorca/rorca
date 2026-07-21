/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { terminalizeFreshRunPreflightFailure } from '../worker-preflight-terminalization';

function dependencies(overrides: Record<string, unknown> = {}) {
  const order: string[] = [];
  const deps = {
    bindFailure: jest.fn(async () => { order.push('bind'); return { workspace_id: 'ws-1' }; }),
    recordFailureAuthority: jest.fn(async () => { order.push('failure_authority'); }),
    transition: jest.fn(async () => { order.push('transition'); return true; }),
    persistCloseout: jest.fn(async () => { order.push('host_closeout'); }),
    advance: jest.fn(async () => { order.push('advance'); }),
    ...overrides,
  };
  return { order, deps };
}

describe('fresh worker preflight terminalization', () => {
  test('persists binding, lifecycle, semantic closeout, terminal event, then queue advancement exactly once', async () => {
    const { order, deps } = dependencies();
    await terminalizeFreshRunPreflightFailure(77, 'autonomous_sandbox_preflight_failed', deps);
    expect(order).toEqual(['bind', 'failure_authority', 'transition', 'host_closeout', 'advance']);
    expect(deps.recordFailureAuthority).toHaveBeenCalledWith(77, 'ws-1', 'autonomous_sandbox_preflight_failed');
    expect(deps.persistCloseout).toHaveBeenCalledWith(77);
    expect(deps.advance).toHaveBeenCalledWith('ws-1');
  });

  test('fails closed without WAL acknowledgement or queue advancement when durable binding is absent', async () => {
    const { deps } = dependencies({ bindFailure: jest.fn(async () => undefined) });
    await expect(terminalizeFreshRunPreflightFailure(78, 'worker_preflight_failed', deps)).rejects.toThrow(/could not be bound/);
    expect(deps.recordFailureAuthority).not.toHaveBeenCalled();
    expect(deps.transition).not.toHaveBeenCalled();
    expect(deps.persistCloseout).not.toHaveBeenCalled();
    expect(deps.advance).not.toHaveBeenCalled();
  });

  test('fails closed before closeout when lifecycle transition refuses the state', async () => {
    const { deps } = dependencies({ transition: jest.fn(async () => false) });
    await expect(terminalizeFreshRunPreflightFailure(79, 'worker_preflight_failed', deps)).rejects.toThrow(/transition was refused/);
    expect(deps.persistCloseout).not.toHaveBeenCalled();
    expect(deps.advance).not.toHaveBeenCalled();
  });

  test('does not advance when semantic closeout persistence fails', async () => {
    const { deps } = dependencies({ persistCloseout: jest.fn(async () => { throw new Error('WAL unavailable'); }) });
    await expect(terminalizeFreshRunPreflightFailure(80, 'worker_preflight_failed', deps)).rejects.toThrow(/WAL unavailable/);
    expect(deps.advance).not.toHaveBeenCalled();
  });
});
