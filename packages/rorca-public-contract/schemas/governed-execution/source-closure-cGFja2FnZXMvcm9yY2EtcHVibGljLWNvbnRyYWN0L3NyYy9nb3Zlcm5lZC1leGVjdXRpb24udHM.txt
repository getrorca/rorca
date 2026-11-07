/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { z } from 'zod';
import { GOVERNED_CONTRACT_SCHEMAS } from '../../../backend/src/lib/governed-contracts';

/** Independently buildable governed-execution contract entrypoint. */
export * from '../../../backend/src/lib/governed-contracts';

/**
 * JSON files published under `schemas/governed-execution` are structural
 * projections. This parser is the canonical public semantic-validation
 * boundary and applies every authority and cross-field Zod refinement.
 */
export const GOVERNED_EXECUTION_JSON_SCHEMA_CLASSIFICATION = 'structural-only' as const;
export type GovernedExecutionContractName = keyof typeof GOVERNED_CONTRACT_SCHEMAS;
export type GovernedExecutionContractValue<Name extends GovernedExecutionContractName> =
  z.output<(typeof GOVERNED_CONTRACT_SCHEMAS)[Name]>;

export function parseGovernedExecutionContract<Name extends GovernedExecutionContractName>(
  contract: Name,
  input: unknown,
): GovernedExecutionContractValue<Name> {
  const schema = GOVERNED_CONTRACT_SCHEMAS[contract];
  if (!schema) throw new TypeError(`Unknown governed-execution contract: ${String(contract)}`);
  return schema.parse(input) as GovernedExecutionContractValue<Name>;
}
