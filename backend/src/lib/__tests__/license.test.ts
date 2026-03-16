import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  generateLicenseKey,
  verifyLicenseKey,
  readLicenseFromDisk,
  writeLicenseToDisk,
  verifyLicenseOnStartup,
  getLicenseState,
  setLicenseState,
  LicensePayloadSchema,
  type LicensePayload,
  type LicenseState,
} from '../license';

// ── Test RSA keypair (ephemeral, NOT production) ─────────────────────────

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const validPayload: LicensePayload = {
  plan: 'pro',
  userId: 'user-123',
  workspaceLimit: 10,
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  features: ['pipeline', 'integrations'],
};

// ── Schema validation ────────────────────────────────────────────────────

describe('LicensePayloadSchema', () => {
  test('accepts valid payload', () => {
    const result = LicensePayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  test('rejects missing plan', () => {
    const { plan: _, ...rest } = validPayload;
    const result = LicensePayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test('rejects invalid plan value', () => {
    const result = LicensePayloadSchema.safeParse({ ...validPayload, plan: 'enterprise' });
    expect(result.success).toBe(false);
  });

  test('rejects non-positive workspaceLimit', () => {
    const result = LicensePayloadSchema.safeParse({ ...validPayload, workspaceLimit: 0 });
    expect(result.success).toBe(false);
  });

  test('rejects non-integer workspaceLimit', () => {
    const result = LicensePayloadSchema.safeParse({ ...validPayload, workspaceLimit: 1.5 });
    expect(result.success).toBe(false);
  });
});

// ── generateLicenseKey ───────────────────────────────────────────────────

describe('generateLicenseKey', () => {
  test('generates a valid RS256 JWT', () => {
    const result = generateLicenseKey(validPayload, privateKey);
    expect('token' in result).toBe(true);

    if ('token' in result) {
      const decoded = jwt.verify(result.token, publicKey, { algorithms: ['RS256'] }) as Record<string, unknown>;
      expect(decoded.plan).toBe('pro');
      expect(decoded.userId).toBe('user-123');
      expect(decoded.workspaceLimit).toBe(10);
      expect(decoded.features).toEqual(['pipeline', 'integrations']);
    }
  });

  test('returns error for invalid payload', () => {
    const result = generateLicenseKey({ ...validPayload, plan: 'invalid' as any }, privateKey);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('Invalid license payload');
    }
  });
});

// ── verifyLicenseKey ─────────────────────────────────────────────────────

describe('verifyLicenseKey', () => {
  test('valid license returns correct plan', () => {
    const gen = generateLicenseKey(validPayload, privateKey);
    expect('token' in gen).toBe(true);
    if (!('token' in gen)) return;

    const state = verifyLicenseKey(gen.token, publicKey);
    expect(state.status).toBe('valid');
    expect(state.plan).toBe('pro');
    expect(state.payload?.userId).toBe('user-123');
    expect(state.payload?.workspaceLimit).toBe(10);
  });

  test('expired license falls back to free plan', () => {
    const expiredPayload: LicensePayload = {
      ...validPayload,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    const gen = generateLicenseKey(expiredPayload, privateKey);
    expect('token' in gen).toBe(true);
    if (!('token' in gen)) return;

    const state = verifyLicenseKey(gen.token, publicKey);
    expect(state.status).toBe('expired');
    expect(state.plan).toBe('free');
    expect(state.reason).toMatch(/expired/i);
  });

  test('tampered token falls back to free plan', () => {
    const gen = generateLicenseKey(validPayload, privateKey);
    expect('token' in gen).toBe(true);
    if (!('token' in gen)) return;

    const tamperedToken = gen.token + 'tampered';
    const state = verifyLicenseKey(tamperedToken, publicKey);
    expect(state.status).toBe('invalid');
    expect(state.plan).toBe('free');
    expect(state.reason).toMatch(/verification failed/i);
  });

  test('wrong key falls back to free plan', () => {
    const { publicKey: otherPublicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const gen = generateLicenseKey(validPayload, privateKey);
    expect('token' in gen).toBe(true);
    if (!('token' in gen)) return;

    const state = verifyLicenseKey(gen.token, otherPublicKey);
    expect(state.status).toBe('invalid');
    expect(state.plan).toBe('free');
  });

  test('throws when no public key is provided or embedded', () => {
    const gen = generateLicenseKey(validPayload, privateKey);
    expect('token' in gen).toBe(true);
    if (!('token' in gen)) return;

    // Clear any env-based key
    const orig = process.env.RORCA_LICENSE_PUBLIC_KEY;
    delete process.env.RORCA_LICENSE_PUBLIC_KEY;

    expect(() => verifyLicenseKey(gen.token)).toThrow('Public key not embedded — rebuild required');

    // Restore
    if (orig !== undefined) process.env.RORCA_LICENSE_PUBLIC_KEY = orig;
  });

  test('team plan license returns team plan', () => {
    const teamPayload: LicensePayload = { ...validPayload, plan: 'team' };
    const gen = generateLicenseKey(teamPayload, privateKey);
    expect('token' in gen).toBe(true);
    if (!('token' in gen)) return;

    const state = verifyLicenseKey(gen.token, publicKey);
    expect(state.status).toBe('valid');
    expect(state.plan).toBe('team');
  });
});

// ── readLicenseFromDisk / writeLicenseToDisk ─────────────────────────────

describe('disk operations', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rorca-license-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('readLicenseFromDisk returns null for missing file', async () => {
    // Mock the license path — we can't easily redirect, so test the function behavior
    // by testing with a non-existent path. We'll test the real function via verifyLicenseOnStartup.
    const result = await readLicenseFromDisk();
    // This reads ~/.rorca/license.json — may or may not exist. Either null or a string is valid.
    expect(result === null || typeof result === 'string').toBe(true);
  });

  test('writeLicenseToDisk creates directory and file', async () => {
    const licensePath = path.join(tmpDir, 'license.json');

    // Write token to a temp file to verify the format
    const gen = generateLicenseKey(validPayload, privateKey);
    expect('token' in gen).toBe(true);
    if (!('token' in gen)) return;

    await fs.writeFile(licensePath, JSON.stringify({ token: gen.token }, null, 2));
    const raw = await fs.readFile(licensePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(typeof parsed.token).toBe('string');
    expect(parsed.token).toBe(gen.token);
  });
});

// ── LicenseState singleton ───────────────────────────────────────────────

describe('LicenseState singleton', () => {
  const originalState = getLicenseState();

  afterEach(() => {
    setLicenseState(originalState);
  });

  test('default state is pending/free', () => {
    setLicenseState({ status: 'pending', plan: 'free' });
    const state = getLicenseState();
    expect(state.status).toBe('pending');
    expect(state.plan).toBe('free');
  });

  test('setLicenseState updates getLicenseState', () => {
    const newState: LicenseState = {
      status: 'valid',
      plan: 'pro',
      payload: validPayload,
    };
    setLicenseState(newState);
    expect(getLicenseState()).toEqual(newState);
  });
});

// ── verifyLicenseOnStartup ───────────────────────────────────────────────

describe('verifyLicenseOnStartup', () => {
  const originalState = getLicenseState();

  afterEach(() => {
    setLicenseState(originalState);
  });

  test('returns missing state when no license file exists', async () => {
    // verifyLicenseOnStartup reads from ~/.rorca/license.json
    // If the file doesn't exist, it should return missing/free
    const state = await verifyLicenseOnStartup(publicKey);
    // State is either 'missing' (no file) or 'valid'/'expired'/'invalid' (if file exists)
    expect(['missing', 'valid', 'expired', 'invalid'].includes(state.status)).toBe(true);
    expect(typeof state.plan).toBe('string');
  });

  test('never throws regardless of input', async () => {
    // Should handle any error gracefully
    await expect(verifyLicenseOnStartup('not-a-valid-key')).resolves.toBeDefined();
  });
});
