/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { shouldResolvePiRpcStory } from '../execution-engine';

describe('execution-engine Pi RPC lifecycle', () => {
  test('does not treat turn_end as terminal story completion', () => {
    expect(shouldResolvePiRpcStory('turn_end')).toBe(false);
  });

  test('waits for agent_end before resolving the story', () => {
    expect(shouldResolvePiRpcStory('agent_end')).toBe(true);
  });
});
