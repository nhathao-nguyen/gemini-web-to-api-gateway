import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

export interface GatewayConfig {
  port: number;
  host: string;
  masterEncryptionKey: Buffer;
  adminApiKey: string;
  adminUsername: string;
  adminPassword?: string;
  requestTimeout: number;
  maxUpstreamAttempts: number;
  logLevel: string;
  databaseUrl?: string;
  redisUrl?: string;
  corsOrigins: string[];
  isProduction: boolean;
}

export function resolveMasterEncryptionKey(rawKeyInput?: string, isProdInput?: boolean): Buffer {
  const isProd = isProdInput !== undefined ? isProdInput : process.env.NODE_ENV === 'production';
  const rawKey = (rawKeyInput !== undefined ? rawKeyInput : process.env.MASTER_ENCRYPTION_KEY)?.trim();

  if (rawKey) {
    // 64-char hex string = 32 bytes
    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      return Buffer.from(rawKey, 'hex');
    }
    // 32-byte base64 string (44 chars)
    if (/^[A-Za-z0-9+/]{43}=$/.test(rawKey)) {
      const buf = Buffer.from(rawKey, 'base64');
      if (buf.length === 32) {
        return buf;
      }
    }
    if (isProd) {
      throw new Error(
        'FATAL: MASTER_ENCRYPTION_KEY must be a high-entropy 64-character hex string (32 bytes) or 44-character base64 string in production! Weak or unformatted keys are rejected.'
      );
    }
    // Non-production convenience only
    const buf = Buffer.from(rawKey, 'utf8');
    if (buf.length >= 32) {
      return buf.subarray(0, 32);
    }
  }

  if (isProd) {
    throw new Error(
      'FATAL: MASTER_ENCRYPTION_KEY environment variable is required in production! Generate via `openssl rand -hex 32`.'
    );
  }

  // Local/dev environment fallback: generate a secure ephemeral 32-byte key
  const generatedKey = crypto.randomBytes(32);
  console.warn(
    '[Security Warning] MASTER_ENCRYPTION_KEY not set. Generated a transient 32-byte key for local development. Cookies will not persist across restarts unless MASTER_ENCRYPTION_KEY is configured in .env.'
  );
  return generatedKey;
}

const isProduction = process.env.NODE_ENV === 'production';
const masterEncryptionKey = resolveMasterEncryptionKey();

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

export const config: GatewayConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  masterEncryptionKey,
  adminApiKey: process.env.ADMIN_API_KEY?.trim() || '',
  adminUsername: process.env.ADMIN_USERNAME?.trim() || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD?.trim() || 'admin_secret_key_change_me',
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '60000', 10),
  maxUpstreamAttempts: parseInt(process.env.MAX_UPSTREAM_ATTEMPTS || '2', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  corsOrigins,
  isProduction,
};
