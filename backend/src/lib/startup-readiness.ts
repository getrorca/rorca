/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export interface StartupReadinessDependencies<TRecovery> {
  initializeTransport(): Promise<void>;
  recoverPublications(): Promise<TRecovery>;
  cleanupOrphanRuns(): Promise<unknown>;
  recoverStoryLogs(): Promise<unknown>;
}

export interface StartupReadinessResult<TRecovery> {
  publicationRecovery: TRecovery;
}

/**
 * Required fail-closed startup sequence. Queue creation happens inside
 * initializeTransport, then durable publication and run/log recovery complete
 * before the caller is allowed to bind its HTTP readiness listener.
 */
export async function awaitRequiredStartupReadiness<TRecovery>(
  dependencies: StartupReadinessDependencies<TRecovery>,
): Promise<StartupReadinessResult<TRecovery>> {
  await dependencies.initializeTransport();
  const publicationRecovery = await dependencies.recoverPublications();
  await dependencies.cleanupOrphanRuns();
  await dependencies.recoverStoryLogs();
  return { publicationRecovery };
}

export async function terminateFailedStartup(dependencies: {
  stopResources(): Promise<void>;
  terminate(code: number): void;
}): Promise<void> {
  try {
    await dependencies.stopResources();
  } finally {
    dependencies.terminate(1);
  }
}
