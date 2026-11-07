/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Authoring validation constrains relayed/service authority. A direct local
 * human may still make the narrower review disposition to approve a spec;
 * lifecycle compilation remains a separate readiness concern.
 */
export function requiresValidatedAuthoringForApproval(input: {
  hasAuthoringMetadata: boolean;
  authoringState: unknown;
  localHumanApprovalPrincipal: boolean;
}): boolean {
  return input.hasAuthoringMetadata
    && input.authoringState !== 'validated'
    && !input.localHumanApprovalPrincipal;
}
