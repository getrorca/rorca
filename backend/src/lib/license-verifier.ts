/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createSign, createVerify } from 'node:crypto';
import type { RorcaPlan } from './tier-auth';

export interface LicensePayload {
  sub: string;
  plan: 'solo' | 'pro' | 'team' | 'enterprise';
  iss?: string;
  issuedAt?: string;
  expiresAt?: string | null;
}

export interface LicenseVerificationResult {
  valid: boolean;
  plan: RorcaPlan | 'solo';
  expiresAt: Date | null;
  payload: LicensePayload | null;
  error?: string;
}

const EMBEDDED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAK0g6g4bh4kqQ0xC4xwNL1sN4R2tQeM+c/fi
EuA8Lzg6M0rkS1qu3mM1xRkP0l0gJ0wM6t2L7Q8rj1tYtR7aR0LkFZ8CAwEAAQ==
-----END PUBLIC KEY-----`;

function getPublicKey(): string {
  return process.env.RORCA_LICENSE_PUBLIC_KEY || EMBEDDED_PUBLIC_KEY;
}

function decodePayload(payloadB64: string): LicensePayload | null {
  try {
    const raw = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as Partial<LicensePayload>;
    if (!parsed || typeof parsed.sub !== 'string' || typeof parsed.plan !== 'string') {
      return null;
    }
    if (!['solo', 'pro', 'team', 'enterprise'].includes(parsed.plan)) {
      return null;
    }
    return parsed as LicensePayload;
  } catch {
    return null;
  }
}

function parseExpiresAt(expiresAt: string | null | undefined): Date | null {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function createSignedLicense(payload: LicensePayload, privateKey: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signer = createSign('SHA256');
  signer.update(payloadB64);
  signer.end();
  const signatureB64 = signer.sign(privateKey).toString('base64url');
  return `${payloadB64}.${signatureB64}`;
}

export function verifyLicense(licenseKey: string): LicenseVerificationResult {
  if (typeof licenseKey !== 'string') {
    return { valid: false, plan: 'free', expiresAt: null, payload: null, error: 'Malformed license key' };
  }

  const segments = licenseKey.split('.');
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    return { valid: false, plan: 'free', expiresAt: null, payload: null, error: 'Malformed license key' };
  }

  const [payloadB64, signatureB64] = segments;
  const payload = decodePayload(payloadB64);
  if (!payload) {
    return { valid: false, plan: 'free', expiresAt: null, payload: null, error: 'Invalid license payload' };
  }

  if (payload.iss && payload.iss !== 'rorca') {
    return { valid: false, plan: 'free', expiresAt: null, payload: null, error: 'Invalid license issuer' };
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, 'base64url');
  } catch {
    return { valid: false, plan: 'free', expiresAt: null, payload: null, error: 'Invalid signature encoding' };
  }

  const verifier = createVerify('SHA256');
  verifier.update(payloadB64);
  verifier.end();
  if (!verifier.verify(getPublicKey(), signature)) {
    return { valid: false, plan: 'free', expiresAt: null, payload: null, error: 'Signature verification failed' };
  }

  if (payload.expiresAt) {
    const expiresAt = parseExpiresAt(payload.expiresAt);
    if (!expiresAt) {
      return { valid: false, plan: 'free', expiresAt: null, payload: null, error: 'Invalid expiresAt timestamp' };
    }
    if (expiresAt.getTime() < Date.now()) {
      return { valid: true, plan: 'free', expiresAt, payload, error: 'License expired' };
    }
    return { valid: true, plan: payload.plan, expiresAt, payload };
  }

  return { valid: true, plan: payload.plan, expiresAt: null, payload };
}
