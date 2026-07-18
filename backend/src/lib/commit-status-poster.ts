/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Story commit statuses are intentionally outside trusted/governing delivery.
 *
 * Rorca's only GitHub lifecycle projection is the durable, claimable terminal
 * Check Run ledger in check-run-poster.ts. Per-story Statuses API writes had no
 * restart-safe ordered acceptance ledger, so acknowledging trusted WAL while a
 * detached status request was in flight was ambiguous. Rather than pretend that
 * best-effort telemetry is durable, this compatibility seam is explicitly inert.
 */

import type { WalEvent } from './sse-hub';

export async function handleCommitStatusWalEvent(_event: WalEvent): Promise<void> {
  // Deliberate no-op. Do not resolve repository authority or provider tokens.
}

export function startCommitStatusPoster(): void {
  // Compatibility export only; server startup deliberately does not call it.
}
