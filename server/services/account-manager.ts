import crypto from 'crypto';
import { db } from '../db/database.js';
import { GeminiAccount, AccountStatus, AccountQuotaInfo } from '../types.js';
import { encryptCookie } from '../utils/crypto.js';
import { normalizeCookieString, validateGeminiCookie } from '../utils/cookie.js';
import { config } from '../config.js';
import { geminiProvider } from './gemini-adapter/index.js';
import { getProfileDir, cleanupProfileDir, DEFAULT_USER_AGENT } from './browser-manager/stealth-factory.js';

export interface CreateAccountDTO {
  name: string;
  email_label: string;
  cookie: string;
  auth_user?: string;
  priority?: number;
  weight?: number;
  supported_models?: string[];
  proxy_url?: string | null;
}

export class AccountManager {
  /**
   * Return list of accounts sanitized for admin UI (NO cookies returned!)
   */
  public listAccounts(): Omit<GeminiAccount, 'encrypted_cookie'>[] {
    const accounts = db.getAccounts();
    return accounts.map((acc) => {
      const { encrypted_cookie, ...safe } = acc;
      return safe;
    });
  }

  public getAccount(id: string): GeminiAccount | undefined {
    return db.getAccountById(id);
  }

  public createAccount(dto: CreateAccountDTO): Omit<GeminiAccount, 'encrypted_cookie'> {
    const cookieValidation = validateGeminiCookie(dto.cookie);
    if (!cookieValidation.valid) {
      throw new Error(`Invalid cookie format: ${cookieValidation.missing.join(', ')}`);
    }

    const id = `acc_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    const encryptedCookie = encryptCookie(cookieValidation.normalized, config.masterEncryptionKey);

    const account: GeminiAccount = {
      id,
      name: dto.name.trim(),
      email_label: dto.email_label.trim(),
      encrypted_cookie: encryptedCookie,
      auth_user: dto.auth_user || '0',
      status: 'ACTIVE',
      priority: dto.priority ?? 10,
      weight: dto.weight ?? 1,
      supported_models: dto.supported_models && dto.supported_models.length > 0 ? dto.supported_models : [],
      proxy_url: dto.proxy_url || null,
      profile_dir: getProfileDir(id),
      user_agent: DEFAULT_USER_AGENT,
      locale: 'en-US',
      timezone: 'America/New_York',
      last_keepalive_at: now,
      keepalive_status: 'IDLE',
      last_success_at: null,
      last_error_at: null,
      last_error: null,
      cooldown_until: null,
      consecutive_errors: 0,
      request_count: 0,
      created_at: now,
      updated_at: now,
    };

    db.createAccount(account);
    db.addAccountEvent({
      id: `evt_${crypto.randomBytes(8).toString('hex')}`,
      account_id: id,
      event_type: 'ACCOUNT_CREATED',
      from_status: null,
      to_status: 'ACTIVE',
      reason: 'Account registered by admin',
      created_at: now,
    });

    const { encrypted_cookie, ...safe } = account;
    return safe;
  }

  public replaceCookie(id: string, newCookie: string): boolean {
    const account = db.getAccountById(id);
    if (!account) return false;

    const cookieValidation = validateGeminiCookie(newCookie);
    if (!cookieValidation.valid) {
      throw new Error(`Invalid cookie format: ${cookieValidation.missing.join(', ')}`);
    }

    const encryptedCookie = encryptCookie(cookieValidation.normalized, config.masterEncryptionKey);
    db.updateAccount(id, {
      encrypted_cookie: encryptedCookie,
      status: 'ACTIVE',
      consecutive_errors: 0,
      last_error: null,
      cooldown_until: null,
    });

    geminiProvider.invalidateSession(id);

    db.addAccountEvent({
      id: `evt_${crypto.randomBytes(8).toString('hex')}`,
      account_id: id,
      event_type: 'COOKIE_REPLACED',
      from_status: account.status,
      to_status: 'ACTIVE',
      reason: 'Admin updated session cookie',
      created_at: new Date().toISOString(),
    });

    return true;
  }

  public setStatus(id: string, status: AccountStatus, reason = 'Admin manual update'): boolean {
    const account = db.getAccountById(id);
    if (!account) return false;

    db.updateAccount(id, { status });
    db.addAccountEvent({
      id: `evt_${crypto.randomBytes(8).toString('hex')}`,
      account_id: id,
      event_type: 'STATUS_CHANGED',
      from_status: account.status,
      to_status: status,
      reason,
      created_at: new Date().toISOString(),
    });
    return true;
  }

  public async testSession(id: string): Promise<{ valid: boolean; error?: string; status: AccountStatus; models?: string[] }> {
    const account = db.getAccountById(id);
    if (!account) {
      return { valid: false, error: 'Account not found', status: 'ERROR' };
    }

    const health = await geminiProvider.ValidateSession(account);
    const oldStatus = account.status;
    const newStatus = health.accountStatus;

    const updates: Partial<GeminiAccount> = {
      status: newStatus,
      last_error: health.error || null,
      last_error_at: health.valid ? account.last_error_at : new Date().toISOString(),
      last_success_at: health.valid ? new Date().toISOString() : account.last_success_at,
    };
    if (health.valid && health.models && health.models.length > 0 && (!account.supported_models || account.supported_models.length === 0)) {
      updates.supported_models = health.models;
    }

    db.updateAccount(id, updates);

    db.addAccountEvent({
      id: `evt_${crypto.randomBytes(8).toString('hex')}`,
      account_id: id,
      event_type: 'SESSION_TESTED',
      from_status: oldStatus,
      to_status: newStatus,
      reason: health.valid ? 'Session test passed' : `Test failed: ${health.error}`,
      created_at: new Date().toISOString(),
    });

    return {
      valid: health.valid,
      error: health.error,
      status: newStatus,
      models: health.models,
    };
  }

  public updateAccount(id: string, updates: Partial<GeminiAccount>): Omit<GeminiAccount, 'encrypted_cookie'> | undefined {
    const account = db.getAccountById(id);
    if (!account) return undefined;

    if (updates.auth_user !== undefined && updates.auth_user !== account.auth_user) {
      geminiProvider.invalidateSession(id);
    }

    const { encrypted_cookie, id: _id, ...safeUpdates } = updates as any;
    const updated = db.updateAccount(id, safeUpdates);
    if (!updated) return undefined;

    const { encrypted_cookie: _, ...safe } = updated;
    return safe;
  }

  public deleteAccount(id: string): boolean {
    const account = db.getAccountById(id);
    if (!account) return false;

    geminiProvider.invalidateSession(id);

    const deleted = db.deleteAccount(id);
    if (deleted) {
      cleanupProfileDir(id).catch((err) => console.warn(`Failed to cleanup profile dir for ${id}:`, err));
      db.addAccountEvent({
        id: `evt_${crypto.randomBytes(8).toString('hex')}`,
        account_id: id,
        event_type: 'ACCOUNT_DELETED',
        from_status: account.status,
        to_status: 'DISABLED',
        reason: 'Account deleted by admin',
        created_at: new Date().toISOString(),
      });
    }
    return deleted;
  }

  public async getAccountQuota(id: string): Promise<AccountQuotaInfo> {
    const account = db.getAccountById(id);
    if (!account) {
      throw new Error(`Account ${id} not found`);
    }
    return geminiProvider.getAccountQuota(account);
  }
}

export const accountManager = new AccountManager();
