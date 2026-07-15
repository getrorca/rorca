/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { mayFinalizePtyCancellationInline } from '../pty-cancel-policy';

describe('mayFinalizePtyCancellationInline', () => {
  it('defers active durable PTYs to the worker when the API cannot see its PID namespace', () => {
    expect(mayFinalizePtyCancellationInline(false, 'active')).toBe(false);
  });

  it('allows inline finalization only after no engine or active PTY remains', () => {
    expect(mayFinalizePtyCancellationInline(false, 'exited')).toBe(true);
    expect(mayFinalizePtyCancellationInline(false, null)).toBe(true);
    expect(mayFinalizePtyCancellationInline(true, 'exited')).toBe(false);
  });
});
