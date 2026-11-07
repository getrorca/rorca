/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Host sandbox and native-PTY failures cannot succeed on retry.  Keep their
 * classification independent from provider output so queue policy can terminalize
 * them before another story attempt is admitted.
 */
const SANDBOX_INFRASTRUCTURE_FAILURE = /(?:sandbox-exec|seatbelt|sandboxd|sandbox(?:\s|[-_])*(?:deny|violation|profile|failure)|operation not permitted.*sandbox|node-pty|pty\.node|native (?:module|binding)|module did not self-register|could not locate (?:the )?bindings file|dlopen\([^)]*(?:pty|node))/i;

export interface SandboxInfrastructureFailure {
  category: 'sandbox_infrastructure_failure';
  message: string;
  retryable: false;
}

/** Classify terminal host-isolation and native-binding faults from child stderr. */
export function classifySandboxInfrastructureFailure(output: string): SandboxInfrastructureFailure | null {
  if (!SANDBOX_INFRASTRUCTURE_FAILURE.test(output)) return null;
  return {
    category: 'sandbox_infrastructure_failure',
    message: output.trim().slice(0, 300) || 'Pi sandbox or native binding infrastructure failed',
    retryable: false,
  };
}
