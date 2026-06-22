/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// Frontend UI rendering consumes the same canonical map as backend readiness,
// repair, workflow, and MCP/API code. Keep this file as a thin browser-safe
// re-export so callers under src/ do not reach into backend paths directly.
export {
  SpecReadinessReasonCode,
  SpecWorkflowReasonCode,
} from '../../backend/src/reason-codes';
export type {
  SpecOperationalReasonCode,
  SpecReadinessReason,
  SpecReadinessReasonSeverity,
} from '../../backend/src/reason-codes';
