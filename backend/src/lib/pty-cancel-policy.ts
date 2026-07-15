/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Decide whether the API can safely finalize a cancelled run itself.
 *
 * Worker and API can run in separate containers, so a worker-side PTY PID is
 * not meaningful in the API container's PID namespace. A durable active PTY
 * session must consequently be handed to the worker for process-group cleanup.
 */
export function mayFinalizePtyCancellationInline(
  enginePidAlive: boolean,
  ptySessionStatus: string | null | undefined,
): boolean {
  return !enginePidAlive && ptySessionStatus !== 'active';
}
