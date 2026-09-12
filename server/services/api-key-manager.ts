import crypto from 'crypto';
import { db } from '../db/database.js';
import { ApiKey } from '../types.js';
import { generateApiKey, hashApiKey } from '../utils/crypto.js';

export interface CreateApiKeyDTO {
  name: string;
  allowed_models?: string[];
  rpm_limit?: number;
  concurrent_limit?: number;
  daily_request_limit?: number;
  expires_in_days?: number;
}

/**
 * Fields a client is allowed to change. Identity/secret fields
 * (id, key_hash, key_prefix, created_at, last_used_at) can never be mass-assigned.
 */
const MUTABLE_API_KEY_FIELDS = [
  'name',
  'enabled',
  'allowed_models',
  'rpm_limit',
  'concurrent_limit',
  'daily_request_limit',
  'expires_at',
] as const;

export function sanitizeApiKeyUpdates(updates: Record<string, any>): Partial<ApiKey> {
  const clean: Record<string, any> = {};
  for (const field of MUTABLE_API_KEY_FIELDS) {
    if (updates[field] !== undefined) clean[field] = updates[field];
  }
  return clean as Partial<ApiKey>;
}

export class ApiKeyManager {
  public listApiKeys(): ApiKey[] {
    return db.getApiKeys();
  }

  public getApiKey(id: string): ApiKey | undefined {
    return db.getApiKeyById(id);
  }

  /**
   * Creates a new Gateway API key.
   * Returns plaintext apiKey ONCE to display to the user.
   */
  public createApiKey(dto: CreateApiKeyDTO): { keyRecord: ApiKey; plainApiKey: string } {
    const { apiKey, prefix, hash } = generateApiKey();
    const id = `key_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    let expiresAt: string | null = null;
    if (dto.expires_in_days && dto.expires_in_days > 0) {
      const exp = new Date(Date.now() + dto.expires_in_days * 24 * 60 * 60 * 1000);
      expiresAt = exp.toISOString();
    }

    const keyRecord: ApiKey = {
      id,
      name: dto.name,
      key_prefix: prefix,
      key_hash: hash,
      enabled: true,
      allowed_models: dto.allowed_models || ['*'],
      rpm_limit: dto.rpm_limit || 60,
      concurrent_limit: dto.concurrent_limit || 5,
      daily_request_limit: dto.daily_request_limit || 5000,
      expires_at: expiresAt,
      created_at: now,
      last_used_at: null,
    };

    db.createApiKey(keyRecord);

    return { keyRecord, plainApiKey: apiKey };
  }

  public updateApiKey(id: string, updates: Partial<ApiKey>): ApiKey | undefined {
    return db.updateApiKey(id, sanitizeApiKeyUpdates(updates as Record<string, any>));
  }

  public deleteApiKey(id: string): boolean {
    return db.deleteApiKey(id);
  }

  /**
   * Authenticate Bearer header 'Bearer sk-gmgw-...'
   */
  public authenticate(authHeader?: string): { authenticated: boolean; apiKey?: ApiKey; error?: string } {
    if (!authHeader) {
      return { authenticated: false, error: 'Missing Authorization header' };
    }

    const match = authHeader.match(/^Bearer\s+(sk-gmgw-[a-zA-Z0-9_-]+)$/);
    if (!match || !match[1]) {
      return { authenticated: false, error: 'Invalid API key format. Must be Bearer sk-gmgw-...' };
    }

    const plainKey = match[1];
    const hash = hashApiKey(plainKey);
    const keyRecord = db.getApiKeyByHash(hash);

    if (!keyRecord) {
      return { authenticated: false, error: 'Invalid or revoked API key' };
    }

    if (!keyRecord.enabled) {
      return { authenticated: false, error: 'This API key has been disabled' };
    }

    if (keyRecord.expires_at) {
      const expiresAt = new Date(keyRecord.expires_at).getTime();
      if (Date.now() > expiresAt) {
        return { authenticated: false, error: 'API key has expired' };
      }
    }

    // Update last_used_at
    db.updateApiKey(keyRecord.id, { last_used_at: new Date().toISOString() });

    return { authenticated: true, apiKey: keyRecord };
  }

  /**
   * Check if requested model is allowed by API key permissions
   */
  public isModelAllowed(apiKey: ApiKey, model: string): boolean {
    if (!apiKey.allowed_models || apiKey.allowed_models.length === 0) {
      return true;
    }
    if (apiKey.allowed_models.includes('*')) {
      return true;
    }
    return apiKey.allowed_models.some(
      (m) => m.toLowerCase() === model.toLowerCase() || model.toLowerCase().includes(m.toLowerCase())
    );
  }
}

export const apiKeyManager = new ApiKeyManager();
