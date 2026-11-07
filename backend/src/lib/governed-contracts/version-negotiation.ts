/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export type VersionNegotiationResult =
  | { accepted: true; mode: 'current' | 'read_older_minor'; readerVersion: string; writerVersion: string }
  | { accepted: false; reason: 'malformed_version' | 'unsupported_major' | 'reader_too_old' };

function parse(value: string): [number, number, number] | null {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Readers may read declared older minors; all writers emit only current v1. */
export function negotiateGovernedContractVersion(input: {
  readerVersion: string; artifactVersion: string; currentWriterVersion?: string;
}): VersionNegotiationResult {
  const reader = parse(input.readerVersion); const artifact = parse(input.artifactVersion);
  const writer = parse(input.currentWriterVersion ?? '1.0.0');
  if (!reader || !artifact || !writer) return { accepted: false, reason: 'malformed_version' };
  if (reader[0] !== artifact[0] || artifact[0] !== writer[0]) return { accepted: false, reason: 'unsupported_major' };
  if (reader[1] < artifact[1]) return { accepted: false, reason: 'reader_too_old' };
  return { accepted: true, mode: artifact[1] === writer[1] ? 'current' : 'read_older_minor', readerVersion: input.readerVersion, writerVersion: input.currentWriterVersion ?? '1.0.0' };
}

export const GOVERNED_STATE_TRANSITIONS = Object.freeze({
  mission: { compiled: ['active', 'rejected'], active: ['superseded'], superseded: [], rejected: [] },
  workPackage: { proposed: ['accepted', 'rejected', 'stale'], accepted: ['active'], active: ['superseded', 'cancelled'], superseded: [], cancelled: [], rejected: [], stale: [] },
  lease: { proposed: ['active'], active: ['released', 'expired', 'cancelled', 'superseded'], released: [], expired: [], cancelled: [], superseded: [] },
  dispatch: { proposed: ['lease_verified', 'rejected'], lease_verified: ['authorized', 'expired', 'rejected'], authorized: ['dispatched', 'expired', 'failed', 'quarantined'], dispatched: ['settled', 'failed', 'quarantined'], settled: [], rejected: [], expired: [], failed: [], quarantined: [] },
} as const);

export function isGovernedTransitionAllowed(family: keyof typeof GOVERNED_STATE_TRANSITIONS, from: string, to: string): boolean {
  const transitions = GOVERNED_STATE_TRANSITIONS[family] as Record<string, readonly string[]>;
  return transitions[from]?.includes(to) ?? false;
}
