/**
 * License key verification for Rorca billing.
 *
 * License keys are RS256-signed JWTs issued by Rorca cloud (or offline tooling).
 * The public key is bundled — no network call needed for verification.
 *
 * JWT payload shape:
 *   { sub: string; plan: PlanId; iat: number; exp?: number; iss: 'rorca' }
 */
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';

export interface LicensePayload {
  sub: string;          // licensee identifier (email or org id)
  plan: string;         // 'solo' | 'pro' | 'team' | 'enterprise'
  iat: number;          // issued at
  exp?: number;         // expiry (optional — perpetual licenses omit this)
  iss: string;          // must be 'rorca'
}

// Load public key from file, falling back to env var
function loadPublicKey(): string {
  // 1. Env var override (useful for tests and cloud deployments)
  if (process.env.RORCA_LICENSE_PUBLIC_KEY) {
    return process.env.RORCA_LICENSE_PUBLIC_KEY;
  }

  // 2. Bundled key file
  const keyPath = path.join(__dirname, '..', 'keys', 'license.pub.pem');
  try {
    return fs.readFileSync(keyPath, 'utf-8');
  } catch {
    throw new Error(
      'License public key not found. Set RORCA_LICENSE_PUBLIC_KEY env var or place key at backend/src/keys/license.pub.pem'
    );
  }
}

/**
 * Verify a license key JWT and return the decoded payload.
 * Throws if the token is invalid, expired, or not issued by 'rorca'.
 */
export function verifyLicense(licenseKey: string): LicensePayload {
  const publicKey = loadPublicKey();

  const decoded = jwt.verify(licenseKey, publicKey, {
    algorithms: ['RS256'],
    issuer: 'rorca',
  }) as LicensePayload;

  // Validate required fields
  if (!decoded.plan || typeof decoded.plan !== 'string') {
    throw new Error('License key missing required "plan" claim');
  }

  const validPlans = ['solo', 'pro', 'team', 'enterprise'];
  if (!validPlans.includes(decoded.plan)) {
    throw new Error(`Invalid plan in license key: ${decoded.plan}`);
  }

  return decoded;
}
