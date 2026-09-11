import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { GeminiAccount, ApiKey, RequestLog, AccountEvent } from '../types.js';
import { config } from '../config.js';

const { Pool } = pg;

interface DatabaseData {
  accounts: GeminiAccount[];
  api_keys: ApiKey[];
  request_logs: RequestLog[];
  account_events: AccountEvent[];
  settings: Record<string, any>;
}

export class Database {
  private data: DatabaseData;
  private pgPool: pg.Pool | null = null;
  private isPgReady: boolean = false;
  private isProduction: boolean;

  constructor(options?: { isProduction?: boolean; databaseUrl?: string }) {
    this.isProduction = options?.isProduction !== undefined ? options.isProduction : config.isProduction;
    const dbUrl = options?.databaseUrl !== undefined ? options.databaseUrl : config.databaseUrl;

    this.data = {
      accounts: [],
      api_keys: [],
      request_logs: [],
      account_events: [],
      settings: {
        request_body_logging: false,
        max_upstream_attempts: 2,
      },
    };

    if (this.isProduction && !dbUrl) {
      throw new Error(
        'FATAL: DATABASE_URL environment variable is strictly required in production mode! JSON file fallback has been completely removed.'
      );
    }

    if (dbUrl) {
      this.initializePostgres(dbUrl);
    } else {
      console.log(
        '[Database] Running in transient in-memory store for local development/testing. Set DATABASE_URL to connect to PostgreSQL.'
      );
    }
  }

  public async initializePostgres(databaseUrl: string) {
    try {
      this.pgPool = new Pool({
        connectionString: databaseUrl,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      const client = await this.pgPool.connect();
      try {
        console.log('[Database] Connected to PostgreSQL. Initializing schema if needed...');
        const schemaPath = path.join(process.cwd(), 'server', 'db', 'schema.sql');
        if (fs.existsSync(schemaPath)) {
          const sql = fs.readFileSync(schemaPath, 'utf8');
          await client.query(sql);
        }

        // Load existing records from Postgres into in-memory cache
        const accountsRes = await client.query('SELECT * FROM accounts');
        if (accountsRes.rows.length > 0) {
          this.data.accounts = accountsRes.rows.map((r) => ({
            id: r.id,
            name: r.name,
            email_label: r.email_label,
            encrypted_cookie: r.encrypted_cookie,
            auth_user: r.auth_user || '0',
            status: r.status,
            priority: r.priority,
            weight: r.weight,
            supported_models: Array.isArray(r.supported_models)
              ? r.supported_models
              : JSON.parse(r.supported_models || '[]'),
            last_success_at: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
            last_error_at: r.last_error_at ? new Date(r.last_error_at).toISOString() : null,
            last_error: r.last_error,
            cooldown_until: r.cooldown_until ? new Date(r.cooldown_until).toISOString() : null,
            consecutive_errors: r.consecutive_errors || 0,
            request_count: parseInt(r.request_count || '0', 10),
            created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
            updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
          }));
        }

        const keysRes = await client.query('SELECT * FROM api_keys');
        if (keysRes.rows.length > 0) {
          this.data.api_keys = keysRes.rows.map((r) => ({
            id: r.id,
            name: r.name,
            key_prefix: r.key_prefix,
            key_hash: r.key_hash,
            enabled: r.enabled,
            allowed_models: Array.isArray(r.allowed_models)
              ? r.allowed_models
              : JSON.parse(r.allowed_models || '[]'),
            rpm_limit: r.rpm_limit,
            concurrent_limit: r.concurrent_limit,
            daily_request_limit: r.daily_request_limit,
            expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
            created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
            last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
          }));
        }

        this.isPgReady = true;
        console.log(
          `[Database] PostgreSQL ready. Loaded ${this.data.accounts.length} accounts and ${this.data.api_keys.length} API keys.`
        );
      } finally {
        client.release();
      }
    } catch (err) {
      if (this.isProduction) {
        throw new Error(
          `FATAL: PostgreSQL connection failed in production: ${(err as Error).message}. Application startup aborted.`
        );
      } else {
        console.warn('[Database] PostgreSQL connection failed in local dev, using in-memory store:', err);
        this.isPgReady = false;
      }
    }
  }

  public isPostgresConnected(): boolean {
    return this.isPgReady;
  }

  // --- ACCOUNTS ---
  public getAccounts(): GeminiAccount[] {
    return [...this.data.accounts];
  }

  public getAccountById(id: string): GeminiAccount | undefined {
    return this.data.accounts.find((a) => a.id === id);
  }

  public createAccount(account: GeminiAccount): GeminiAccount {
    this.data.accounts.push(account);

    if (this.isPgReady && this.pgPool) {
      this.pgPool
        .query(
          `INSERT INTO accounts (id, name, email_label, encrypted_cookie, auth_user, status, priority, weight, supported_models, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            account.id,
            account.name,
            account.email_label,
            account.encrypted_cookie,
            account.auth_user,
            account.status,
            account.priority,
            account.weight,
            JSON.stringify(account.supported_models),
            account.created_at,
            account.updated_at,
          ]
        )
        .catch((err) => console.error('[Database] Postgres insert account error:', err));
    }

    return account;
  }

  public updateAccount(id: string, updates: Partial<GeminiAccount>): GeminiAccount | undefined {
    const index = this.data.accounts.findIndex((a) => a.id === id);
    if (index === -1) return undefined;

    this.data.accounts[index] = {
      ...this.data.accounts[index],
      ...updates,
      updated_at: new Date().toISOString(),
    };

    const acc = this.data.accounts[index];
    if (this.isPgReady && this.pgPool) {
      this.pgPool
        .query(
          `UPDATE accounts SET
            name = $1,
            encrypted_cookie = $2,
            auth_user = $3,
            status = $4,
            priority = $5,
            weight = $6,
            supported_models = $7,
            last_success_at = $8,
            last_error_at = $9,
            last_error = $10,
            cooldown_until = $11,
            consecutive_errors = $12,
            request_count = $13,
            updated_at = $14
          WHERE id = $15`,
          [
            acc.name,
            acc.encrypted_cookie,
            acc.auth_user,
            acc.status,
            acc.priority,
            acc.weight,
            JSON.stringify(acc.supported_models),
            acc.last_success_at,
            acc.last_error_at,
            acc.last_error,
            acc.cooldown_until,
            acc.consecutive_errors,
            acc.request_count,
            acc.updated_at,
            id,
          ]
        )
        .catch((err) => console.error('[Database] Postgres update account error:', err));
    }

    return acc;
  }

  public deleteAccount(id: string): boolean {
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.accounts.length !== before) {
      if (this.isPgReady && this.pgPool) {
        this.pgPool.query('DELETE FROM accounts WHERE id = $1', [id]).catch((err) => console.error(err));
      }
      return true;
    }
    return false;
  }

  // --- API KEYS ---
  public getApiKeys(): ApiKey[] {
    return [...this.data.api_keys];
  }

  public getApiKeyById(id: string): ApiKey | undefined {
    return this.data.api_keys.find((k) => k.id === id);
  }

  public getApiKeyByHash(hash: string): ApiKey | undefined {
    return this.data.api_keys.find((k) => k.key_hash === hash && k.enabled);
  }

  public createApiKey(key: ApiKey): ApiKey {
    this.data.api_keys.push(key);

    if (this.isPgReady && this.pgPool) {
      this.pgPool
        .query(
          `INSERT INTO api_keys (id, name, key_prefix, key_hash, enabled, allowed_models, rpm_limit, concurrent_limit, daily_request_limit, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            key.id,
            key.name,
            key.key_prefix,
            key.key_hash,
            key.enabled,
            JSON.stringify(key.allowed_models),
            key.rpm_limit,
            key.concurrent_limit,
            key.daily_request_limit,
            key.expires_at,
            key.created_at,
          ]
        )
        .catch((err) => console.error('[Database] Postgres insert api_key error:', err));
    }

    return key;
  }

  public updateApiKey(id: string, updates: Partial<ApiKey>): ApiKey | undefined {
    const index = this.data.api_keys.findIndex((k) => k.id === id);
    if (index === -1) return undefined;

    this.data.api_keys[index] = {
      ...this.data.api_keys[index],
      ...updates,
    };

    const key = this.data.api_keys[index];
    if (this.isPgReady && this.pgPool) {
      this.pgPool
        .query(
          `UPDATE api_keys SET
            name = $1,
            enabled = $2,
            allowed_models = $3,
            rpm_limit = $4,
            concurrent_limit = $5,
            daily_request_limit = $6,
            expires_at = $7,
            last_used_at = $8
          WHERE id = $9`,
          [
            key.name,
            key.enabled,
            JSON.stringify(key.allowed_models),
            key.rpm_limit,
            key.concurrent_limit,
            key.daily_request_limit,
            key.expires_at,
            key.last_used_at,
            id,
          ]
        )
        .catch((err) => console.error('[Database] Postgres update api_key error:', err));
    }

    return this.data.api_keys[index];
  }

  public deleteApiKey(id: string): boolean {
    const before = this.data.api_keys.length;
    this.data.api_keys = this.data.api_keys.filter((k) => k.id !== id);
    if (this.data.api_keys.length !== before) {
      if (this.isPgReady && this.pgPool) {
        this.pgPool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch((err) => console.error(err));
      }
      return true;
    }
    return false;
  }

  // --- LOGS & EVENTS ---
  public addRequestLog(log: RequestLog) {
    this.data.request_logs.unshift(log);
    if (this.data.request_logs.length > 1000) {
      this.data.request_logs = this.data.request_logs.slice(0, 1000);
    }

    if (this.isPgReady && this.pgPool) {
      this.pgPool
        .query(
          `INSERT INTO request_logs (request_id, api_key_id, account_id, model, status, latency_ms, error_code, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            log.request_id,
            log.api_key_id,
            log.account_id,
            log.model,
            log.status,
            log.latency_ms,
            log.error_code,
            log.created_at,
          ]
        )
        .catch((err) => console.error('[Database] Postgres log error:', err));
    }
  }

  public getRequestLogs(limit = 100): RequestLog[] {
    return this.data.request_logs.slice(0, limit);
  }

  public addAccountEvent(event: AccountEvent) {
    this.data.account_events.unshift(event);
    if (this.data.account_events.length > 500) {
      this.data.account_events = this.data.account_events.slice(0, 500);
    }

    if (this.isPgReady && this.pgPool) {
      this.pgPool
        .query(
          `INSERT INTO account_events (id, account_id, event_type, from_status, to_status, reason, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            event.id,
            event.account_id,
            event.event_type,
            event.from_status,
            event.to_status,
            event.reason,
            event.created_at,
          ]
        )
        .catch((err) => console.error('[Database] Postgres event error:', err));
    }
  }

  public getAccountEvents(limit = 100): AccountEvent[] {
    return this.data.account_events.slice(0, limit);
  }

  // --- METRICS ---
  public getAnalytics() {
    const totalRequests = this.data.request_logs.length;
    const successfulRequests = this.data.request_logs.filter((l) => l.status >= 200 && l.status < 400).length;
    const errorRequests = totalRequests - successfulRequests;
    // When no requests have arrived, rate is 0 (never fake 100% or 98.7%)
    const successRate = totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;
    
    const avgLatency =
      totalRequests > 0
        ? Math.round(this.data.request_logs.reduce((acc, l) => acc + l.latency_ms, 0) / totalRequests)
        : 0;

    const requestsByModel: Record<string, number> = {};
    const requestsByAccount: Record<string, number> = {};
    const requestsByApiKey: Record<string, number> = {};

    for (const log of this.data.request_logs) {
      requestsByModel[log.model] = (requestsByModel[log.model] || 0) + 1;
      if (log.account_id) {
        requestsByAccount[log.account_id] = (requestsByAccount[log.account_id] || 0) + 1;
      }
      if (log.api_key_id) {
        requestsByApiKey[log.api_key_id] = (requestsByApiKey[log.api_key_id] || 0) + 1;
      }
    }

    return {
      totalRequests,
      successfulRequests,
      errorRequests,
      successRate: Math.round(successRate * 10) / 10,
      avgLatency,
      requestsByModel,
      requestsByAccount,
      requestsByApiKey,
    };
  }
}

export const db = new Database();
