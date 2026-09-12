import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

export interface GatewayConfig {
  port: number;
  host: string;
  /** Share /v1 API on LAN (0.0.0.0). When false, bind loopback only. */
  shareLan: boolean;
  /** Writable directory for SQLite DB, key file, browser profiles. */
  dataDir: string;
  masterEncryptionKey: Buffer;
  adminApiKey: string;
  adminUsername: string;
  adminPassword?: string;
  requestTimeout: number;
  maxUpstreamAttempts: number;
  logLevel: string;
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

// Desktop data directory: explicit override, else Electron userData (passed via
// GATEWAY_DATA_DIR by the desktop shell), else current working directory.
const dataDir = (process.env.GATEWAY_DATA_DIR || process.cwd()).trim() || process.cwd();

// LAN sharing: explicit opt-in. Desktop defaults to loopback-only.
const shareLan =
  process.env.SHARE_LAN === '1' ||
  (process.env.SHARE_LAN || '').toLowerCase() === 'true' ||
  (process.env.HOST || '').trim() === '0.0.0.0';

const masterEncryptionKey = resolveDesktopMasterKey(dataDir);

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

/**
 * Desktop master-key resolution: explicit env key wins, otherwise a persistent
 * key file inside dataDir (created once, readable only by the owner). This
 * replaces the old ephemeral dev key so encrypted cookies survive restarts
 * without requiring the user to manage env secrets.
 */
function resolveDesktopMasterKey(dir: string): Buffer {
  const fromEnv = (process.env.MASTER_ENCRYPTION_KEY || '').trim();
  if (fromEnv) {
    return resolveMasterEncryptionKey(fromEnv);
  }
  try {
    const keyPath = path.join(dir, '.masterkey');
    if (fs.existsSync(keyPath)) {
      const stored = fs.readFileSync(keyPath, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(stored)) {
        return Buffer.from(stored, 'hex');
      }
    } else {
      const generated = crypto.randomBytes(32).toString('hex');
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(keyPath, generated, { mode: 0o600 });
      } catch {
        fs.writeFileSync(keyPath, generated);
      }
      console.log('[Security] Generated persistent master key. Keep your data directory private.');
      return Buffer.from(generated, 'hex');
    }
  } catch (err) {
    console.warn('[Security] Could not persist master key file, using ephemeral key:', (err as Error).message);
  }
  return resolveMasterEncryptionKey(undefined);
}

export const config: GatewayConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: (process.env.HOST || '').trim() || (shareLan ? '0.0.0.0' : '127.0.0.1'),
  shareLan,
  dataDir,
  masterEncryptionKey,
  adminApiKey: process.env.ADMIN_API_KEY?.trim() || '',
  adminUsername: process.env.ADMIN_USERNAME?.trim() || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD?.trim() || 'admin_secret_key_change_me',
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '60000', 10),
  maxUpstreamAttempts: parseInt(process.env.MAX_UPSTREAM_ATTEMPTS || '2', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  corsOrigins,
  isProduction,
};
