/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { declareHermesAuthority } from '../hermes-authority';
import {
  registerWatchdogWatch,
  stopWatchdogWatch,
  watchdogState,
} from '../hermes-watchdog';

const workspaceId = 'workspace-hermes-authority';

function register(specSlug: string): void {
  registerWatchdogWatch({
    workspaceId,
    specPath: `forge/specs/approved/${specSlug}.json`,
    specSlug,
    authority: declareHermesAuthority('watchdog', 'operator-dispatch'),
  });
}

describe('Hermes watchdog authority boundary', () => {
  test('allows explicitly declared subscription and watchdog actions', () => {
    const specSlug = 'allowed-watch';
    register(specSlug);

    const watches = watchdogState(declareHermesAuthority('subscription', 'service-audit'));
    expect(watches.some((watch) => watch.workspaceId === workspaceId && watch.specSlug === specSlug)).toBe(true);
    expect(stopWatchdogWatch(
      workspaceId,
      specSlug,
      declareHermesAuthority('watchdog', 'operator-dispatch'),
    )).toBe(true);
  });

  test('denies missing authority instead of falling back at direct supervision calls', () => {
    expect(() => watchdogState(undefined as never)).toThrow(/does not permit this action/);
    expect(() => stopWatchdogWatch(workspaceId, 'missing', undefined as never))
      .toThrow(/does not permit this action/);
  });

  test('denies cross-surface authority reuse', () => {
    const subscription = declareHermesAuthority('subscription', 'service-audit');
    const watchdog = declareHermesAuthority('watchdog', 'operator-dispatch');

    expect(() => registerWatchdogWatch({
      workspaceId,
      specPath: 'forge/specs/approved/cross-surface.json',
      specSlug: 'cross-surface',
      authority: subscription,
    })).toThrow(/does not permit this action/);
    expect(() => watchdogState(watchdog)).toThrow(/does not permit this action/);
    expect(() => stopWatchdogWatch(workspaceId, 'cross-surface', subscription))
      .toThrow(/does not permit this action/);
  });
});
