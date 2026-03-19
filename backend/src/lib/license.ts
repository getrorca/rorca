/**
 * BL-003/BL-004: License key verification for offline and cloud-issued licenses.
 *
 * License keys are RS256-signed JWTs. The public key is bundled with the binary
 * so verification works fully offline — no network call required.
 *
 * Expected JWT payload:
 *   { plan: 'solo' | 'pro' | 'team', sub?: string, iat: number, exp?: number }
 */

import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';

export interface LicensePayload {
  plan: string;
  sub?: string;
  iat: number;
  exp?: number;
}

// The RS256 public key used to verify license JWTs.
// Loaded from RORCA_LICENSE_PUBLIC_KEY env var (PEM string),
// or from the bundled file at backend/keys/license.pub.pem.
let cachedPublicKey: string | null = null;

function getPublicKey(): string {
  if (cachedPublicKey) return cachedPublicKey;

  // 1. Environment variable (PEM string)
  if (process.env.RORCA_LICENSE_PUBLIC_KEY) {
    cachedPublicKey = process.env.RORCA_LICENSE_PUBLIC_KEY;
    return cachedPublicKey;
  }

  // 2. Bundled file
  const keyPath = path.join(__dirname, '..', '..', 'keys', 'license.pub.pem');
  try {
    cachedPublicKey = fs.readFileSync(keyPath, 'utf-8');
    return cachedPublicKey;
  } catch {
    throw new Error(
      'License public key not found. Set RORCA_LICENSE_PUBLIC_KEY env var or place key at backend/keys/license.pub.pem'
    );
  }
}

/**
 * Verify a license key JWT using the bundled RS256 public key.
 * Returns the decoded payload if valid, or null if invalid/expired/tampered.
 */
export function verifyLicense(token: string): LicensePayload | null {
  try {
    const publicKey = getPublicKey();
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
    }) as LicensePayload;

    // Validate required fields
    if (!decoded.plan || typeof decoded.plan !== 'string') {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

/** Reset the cached public key (for testing). */
export function _resetKeyCache(): void {
  cachedPublicKey = null;
}
