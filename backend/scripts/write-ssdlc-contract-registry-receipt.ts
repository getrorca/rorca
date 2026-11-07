/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { qualifyExecutorRecoveryMatrix, type ExecutorRecoveryMatrixInput } from '../src/ssdlc/executor-recovery-compatibility';
import { verifyContractRegistry } from '../src/ssdlc/interop/contract-registry';

async function main(): Promise<void> {
  const output = path.resolve(process.cwd(), process.env.RORCA_CONTRACT_RECEIPT_PATH ?? 'artifacts/ssdlc-contract-registry-receipt.json');
  const registry = await verifyContractRegistry();
  const matrixFixturePath = path.resolve(process.cwd(), 'src/ssdlc/interop/__fixtures__/executor-recovery-matrix.v1.json');
  const matrixInput = JSON.parse(await readFile(matrixFixturePath, 'utf8')) as ExecutorRecoveryMatrixInput;
  const executorRecoveryMatrix = await qualifyExecutorRecoveryMatrix(matrixInput, registry.digest);
  const receipt = { ...registry, qualifications: { executorRecoveryMatrix } };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ receipt: output, ...receipt })}\n`);
}

void main();
