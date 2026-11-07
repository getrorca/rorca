/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export const PTY_FEATURE_ENV = {
  structuredPi: 'RORCA_DISABLE_STRUCTURED_PI_MODE',
  checkpointCompaction: 'RORCA_DISABLE_PTY_CHECKPOINT_COMPACTION',
  generationReader: 'RORCA_DISABLE_PTY_GENERATION_READER',
} as const;

function disabled(name: string): boolean {
  // Read process.env on every call. Operators may update the process environment
  // through the supported runtime config surface without recreating readers.
  return /^(?:1|true|yes|on)$/i.test(process.env[name]?.trim() ?? '');
}

export function isStructuredPiModeEnabled(): boolean {
  return !disabled(PTY_FEATURE_ENV.structuredPi);
}

export function isPtyCheckpointCompactionEnabled(): boolean {
  return !disabled(PTY_FEATURE_ENV.checkpointCompaction);
}

export function isPtyGenerationReaderEnabled(): boolean {
  return !disabled(PTY_FEATURE_ENV.generationReader);
}

export function getPtyFeatureControls(): Record<'structuredPi' | 'checkpointCompaction' | 'generationReader', boolean> {
  return {
    structuredPi: isStructuredPiModeEnabled(),
    checkpointCompaction: isPtyCheckpointCompactionEnabled(),
    generationReader: isPtyGenerationReaderEnabled(),
  };
}
