/**
 * US-036: RSA256-signed JWT license key infrastructure.
 *
 * - generateLicenseKey: signs a license payload with RS256 (license server only)
 * - verifyLicenseKey: verifies a license JWT against the embedded public key
 * - readLicenseFromDisk: reads ~/.rorca/license.json
 * - writeLicenseToDisk: writes ~/.rorca/license.json
 * - LicenseState: in-memory singleton for startup verification result
 */

import jwt from 'jsonwebtoken';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ── Types ────────────────────────────────────────────────────────────────

export type LicensePlan = 'pro' | 'team';

export const LicensePayloadSchema = z.object({
  plan: z.enum(['pro', 'team']),
  userId: z.string().min(1),
  workspaceLimit: z.number().int().positive(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  features: z.array(z.string()),
});

export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

export interface LicenseState {
  status: 'pending' | 'valid' | 'expired' | 'invalid' | 'missing';
  plan: LicensePlan | 'free';
  payload?: LicensePayload;
  reason?: string;
}

// ── In-memory singleton ──────────────────────────────────────────────────

let currentLicenseState: LicenseState = {
  status: 'pending',
  plan: 'free',
};

export function getLicenseState(): LicenseState {
  return currentLicenseState;
}

export function setLicenseState(state: LicenseState): void {
  currentLicenseState = state;
}

// ── Embedded public key ──────────────────────────────────────────────────
// In production, this is replaced at build time. For dev, use env var.
// The private key NEVER appears here — it lives on the license server only.

const EMBEDDED_PUBLIC_KEY: string | undefined = process.env.RORCA_LICENSE_PUBLIC_KEY || undefined;

// ── Filesystem helpers ───────────────────────────────────────────────────

const LICENSE_DIR = path.join(os.homedir(), '.rorca');
const LICENSE_PATH = path.join(LICENSE_DIR, 'license.json');

/**
 * Read license token from ~/.rorca/license.json.
 * Returns null if file is missing, unreadable, or malformed.
 */
export async function readLicenseFromDisk(): Promise<string | null> {
  try {
    const raw = await fs.readFile(LICENSE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token !== 'string') {
      console.warn('[License] ~/.rorca/license.json missing "token" field');
      return null;
    }
    return parsed.token;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist — expected for new installs
      return null;
    }
    console.warn('[License] Failed to read ~/.rorca/license.json:', (err as Error).message);
    return null;
  }
}

/**
 * Write license token to ~/.rorca/license.json.
 * Creates the ~/.rorca/ directory if it doesn't exist.
 */
export async function writeLicenseToDisk(token: string): Promise<void> {
  await fs.mkdir(LICENSE_DIR, { recursive: true });
  await fs.writeFile(LICENSE_PATH, JSON.stringify({ token }, null, 2), 'utf-8');
}

// ── Core license operations ──────────────────────────────────────────────

/**
 * Generate a signed license JWT. RS256 algorithm.
 *
 * This function should only be called from the license-issuing service,
 * NOT from the Rorca binary. Included here for completeness and testing.
 */
export function generateLicenseKey(
  payload: LicensePayload,
  privateKey: string,
): { token: string } | { error: string; details?: z.ZodError } {
  const result = LicensePayloadSchema.safeParse(payload);
  if (!result.success) {
    return { error: 'Invalid license payload', details: result.error };
  }

  const token = jwt.sign(result.data, privateKey, {
    algorithm: 'RS256',
  });

  return { token };
}

/**
 * Verify a license JWT against the public key.
 *
 * Returns the decoded payload if valid, or a LicenseState describing the failure.
 * Throws only if the public key is missing (build error).
 */
export function verifyLicenseKey(
  token: string,
  publicKey?: string,
): LicenseState {
  const key = publicKey ?? EMBEDDED_PUBLIC_KEY;

  if (!key) {
    throw new Error('Public key not embedded — rebuild required');
  }

  try {
    const decoded = jwt.verify(token, key, { algorithms: ['RS256'] }) as Record<string, unknown>;

    const parseResult = LicensePayloadSchema.safeParse(decoded);
    if (!parseResult.success) {
      return {
        status: 'invalid',
        plan: 'free',
        reason: 'License payload schema mismatch',
      };
    }

    const payload = parseResult.data;

    // Check expiry from our payload field (not jwt exp)
    const expiresAt = new Date(payload.expiresAt).getTime();
    if (expiresAt < Date.now()) {
      return {
        status: 'expired',
        plan: 'free',
        payload,
        reason: `License expired at ${payload.expiresAt}`,
      };
    }

    return {
      status: 'valid',
      plan: payload.plan,
      payload,
    };
  } catch (err: unknown) {
    const message = (err as Error).message;

    if (message.includes('jwt expired')) {
      return {
        status: 'expired',
        plan: 'free',
        reason: 'JWT signature expired',
      };
    }

    return {
      status: 'invalid',
      plan: 'free',
      reason: `Verification failed: ${message}`,
    };
  }
}

// ── Startup verification ─────────────────────────────────────────────────

/**
 * Run license verification on startup. Non-blocking — updates the
 * in-memory LicenseState singleton. Never throws, never crashes.
 *
 * If publicKey is provided, uses it (for testing). Otherwise uses
 * EMBEDDED_PUBLIC_KEY / RORCA_LICENSE_PUBLIC_KEY env var.
 */
export async function verifyLicenseOnStartup(publicKey?: string): Promise<LicenseState> {
  try {
    const token = await readLicenseFromDisk();

    if (!token) {
      const state: LicenseState = {
        status: 'missing',
        plan: 'free',
        reason: 'No license file found — using free plan',
      };
      setLicenseState(state);
      console.warn(`[License] ${state.reason}`);
      return state;
    }

    const key = publicKey ?? EMBEDDED_PUBLIC_KEY;
    if (!key) {
      // No public key available — can't verify, default to free
      const state: LicenseState = {
        status: 'invalid',
        plan: 'free',
        reason: 'No public key available — using free plan',
      };
      setLicenseState(state);
      console.warn(`[License] ${state.reason}`);
      return state;
    }

    const state = verifyLicenseKey(token, key);
    setLicenseState(state);

    if (state.status === 'valid') {
      console.warn(`[License] Valid license: plan=${state.plan}, userId=${state.payload?.userId}`);
    } else {
      console.warn(`[License] ${state.reason}`);
    }

    return state;
  } catch (err: unknown) {
    const state: LicenseState = {
      status: 'invalid',
      plan: 'free',
      reason: `Startup verification error: ${(err as Error).message}`,
    };
    setLicenseState(state);
    console.warn(`[License] ${state.reason}`);
    return state;
  }
}
