import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard for GCM
const AUTH_TAG_LENGTH = 16;

/**
 * Normalizes masterKey into a strictly 32-byte Buffer
 */
export function toKeyBuffer(masterKey: Buffer | string): Buffer {
  if (Buffer.isBuffer(masterKey)) {
    if (masterKey.length === 32) return masterKey;
    if (masterKey.length > 32) return masterKey.subarray(0, 32);
    throw new Error(`Master key Buffer length must be 32 bytes, got ${masterKey.length}`);
  }
  const trimmed = masterKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  const buf = Buffer.from(trimmed, 'utf-8');
  if (buf.length >= 32) {
    return buf.subarray(0, 32);
  }
  throw new Error(`Master key must be at least 32 bytes or 64 hex characters, got ${buf.length} bytes`);
}

/**
 * Encrypt sensitive cookie string using AES-256-GCM.
 * Output format: iv_hex:auth_tag_hex:encrypted_hex
 */
export function encryptCookie(plainText: string, masterKey: Buffer | string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const keyBuffer = toKeyBuffer(masterKey);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv, { authTagLength: AUTH_TAG_LENGTH });
  
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt sensitive cookie string using AES-256-GCM.
 */
export function decryptCookie(cipherText: string, masterKey: Buffer | string): string {
  const parts = cipherText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format. Expected iv:authTag:cipher');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const keyBuffer = toKeyBuffer(masterKey);

  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Hash API Key using SHA-256 for persistent safe storage.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Generate a new standard Gateway API Key with format: sk-gmgw-<cryptographically-secure-random>
 */
export function generateApiKey(): { apiKey: string; prefix: string; hash: string } {
  const random = crypto.randomBytes(24).toString('base64url');
  const apiKey = `sk-gmgw-${random}`;
  const prefix = apiKey.slice(0, 16); // e.g. "sk-gmgw-K8n2fH7x"
  const hash = hashApiKey(apiKey);
  return { apiKey, prefix, hash };
}
