import crypto from 'crypto';

const TOKEN_CRYPTO_SECRET = process.env.SUPABASE_JWT_SECRET?.trim()
  || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  || process.env.SUPABASE_ANON_KEY?.trim()
  || 'rorca-dev-token-crypto-secret-change-in-production';

const ENCRYPTION_KEY = crypto.createHash('sha256').update(TOKEN_CRYPTO_SECRET).digest();
const ENCRYPTION_ALGO = 'aes-256-gcm' as const;

export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptToken(encryptedStr: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
