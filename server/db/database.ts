import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { GeminiAccount, ApiKey, RequestLog, AccountEvent, Conversation, Message, MediaCache } from '../types.js';
import { config } from '../config.js';

const { Pool } = pg;

interface DatabaseData {
  accounts: GeminiAccount[];
  api_keys: ApiKey[];
  request_logs: RequestLog[];
  account_events: AccountEvent[];
  conversations: Conversation[];
  messages: Message[];
  media_cache: MediaCache[];
  settings: Record<string, any>;
}

export class Database {
  private data: DatabaseData;
  private pgPool: pg.Pool | null = null;
  private isPgReady: boolean = false;
  private sqliteDb: any = null;
  private isSqliteReady: boolean = false;
  private isProduction: boolean;
  private initPromise: Promise<void> | null = null;

  constructor(options?: { isProduction?: boolean; databaseUrl?: string }) {
    this.isProduction = options?.isProduction !== undefined ? options.isProduction : config.isProduction;
    const dbUrl = options?.databaseUrl !== undefined ? options.databaseUrl : config.databaseUrl;

    this.data = {
      accounts: [],
      api_keys: [],
      request_logs: [],
      account_events: [],
      conversations: [],
      messages: [],
      media_cache: [],
      settings: {
        request_body_logging: false,
        max_upstream_attempts: 2,
      },
    };


    if (dbUrl && (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://'))) {
      this.initPromise = this.initializePostgres(dbUrl);
    } else {
      // Default to native, local SQLite database
      this.initializeSqlite();
    }
  }

  public async init(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  public close(): void {
    if (this.sqliteDb) {
      try {
        this.sqliteDb.close();
        console.log('[Database] SQLite connection closed.');
      } catch (err) {
        console.warn('[Database] Error closing SQLite connection:', err);
      }
    }
    if (this.pgPool) {
      try {
        this.pgPool.end();
      } catch {}
    }
  }

  public initializeSqlite(dbFilePath?: string) {
    try {
      const dbPath = dbFilePath || path.join(process.cwd(), 'gateway.db');
      console.log(`[Database] Initializing native SQLite database at: ${dbPath}`);
      this.sqliteDb = new DatabaseSync(dbPath);
      this.sqliteDb.exec('PRAGMA journal_mode = WAL;');
      this.sqliteDb.exec('PRAGMA foreign_keys = ON;');

      this.sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email_label TEXT NOT NULL,
          encrypted_cookie TEXT NOT NULL,
          auth_user TEXT NOT NULL DEFAULT '0',
          status TEXT NOT NULL DEFAULT 'ACTIVE',
          priority INTEGER NOT NULL DEFAULT 10,
          weight INTEGER NOT NULL DEFAULT 1,
          supported_models TEXT NOT NULL DEFAULT '[]',
          proxy_url TEXT,
          profile_dir TEXT,
          user_agent TEXT,
          locale TEXT DEFAULT 'en-US',
          timezone TEXT DEFAULT 'America/New_York',
          last_keepalive_at TEXT,
          keepalive_status TEXT DEFAULT 'IDLE',
          last_success_at TEXT,
          last_error_at TEXT,
          last_error TEXT,
          cooldown_until TEXT,
          consecutive_errors INTEGER NOT NULL DEFAULT 0,
          request_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          key_prefix TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 1,
          allowed_models TEXT NOT NULL DEFAULT '[]',
          rpm_limit INTEGER NOT NULL DEFAULT 60,
          concurrent_limit INTEGER NOT NULL DEFAULT 5,
          daily_request_limit INTEGER NOT NULL DEFAULT 5000,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          last_used_at TEXT
        );

        CREATE TABLE IF NOT EXISTS request_logs (
          request_id TEXT PRIMARY KEY,
          api_key_id TEXT,
          account_id TEXT,
          model TEXT NOT NULL,
          status INTEGER NOT NULL,
          latency_ms INTEGER NOT NULL,
          error_code TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS account_events (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          from_status TEXT,
          to_status TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          model TEXT NOT NULL,
          account_id TEXT NOT NULL,
          upstream_cid TEXT,
          upstream_rid TEXT,
          upstream_rcid TEXT,
          api_key_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          reasoning_content TEXT,
          attachments TEXT NOT NULL DEFAULT '[]',
          generated_media TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS media_cache (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          upstream_url TEXT NOT NULL,
          mime_type TEXT NOT NULL DEFAULT 'image/png',
          file_name TEXT NOT NULL DEFAULT 'image.png',
          data_b64 TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      // SQLite column migrations
      try {
        const tableInfo = this.sqliteDb.prepare('PRAGMA table_info(accounts)').all();
        const existingCols = new Set(tableInfo.map((col: any) => col.name));
        const colsToAdd = [
          { name: 'proxy_url', def: 'TEXT' },
          { name: 'profile_dir', def: 'TEXT' },
          { name: 'user_agent', def: 'TEXT' },
          { name: 'locale', def: "TEXT DEFAULT 'en-US'" },
          { name: 'timezone', def: "TEXT DEFAULT 'America/New_York'" },
          { name: 'last_keepalive_at', def: 'TEXT' },
          { name: 'keepalive_status', def: "TEXT DEFAULT 'IDLE'" },
        ];
        for (const col of colsToAdd) {
          if (!existingCols.has(col.name)) {
            this.sqliteDb.exec(`ALTER TABLE accounts ADD COLUMN ${col.name} ${col.def}`);
          }
        }
      } catch (colErr) {
        console.warn('[Database] SQLite column migration notice:', colErr);
      }

      // Load existing records into in-memory cache
      const accRows = this.sqliteDb.prepare('SELECT * FROM accounts').all();
      if (accRows && accRows.length > 0) {
        this.data.accounts = accRows.map((r: any) => ({
          id: r.id,
          name: r.name,
          email_label: r.email_label,
          encrypted_cookie: r.encrypted_cookie,
          auth_user: r.auth_user || '0',
          status: r.status,
          priority: Number(r.priority || 10),
          weight: Number(r.weight || 1),
          supported_models: JSON.parse(r.supported_models || '[]'),
          proxy_url: r.proxy_url || null,
          profile_dir: r.profile_dir || null,
          user_agent: r.user_agent || null,
          locale: r.locale || 'en-US',
          timezone: r.timezone || 'America/New_York',
          last_keepalive_at: r.last_keepalive_at || null,
          keepalive_status: r.keepalive_status || 'IDLE',
          last_success_at: r.last_success_at || null,
          last_error_at: r.last_error_at || null,
          last_error: r.last_error || null,
          cooldown_until: r.cooldown_until || null,
          consecutive_errors: Number(r.consecutive_errors || 0),
          request_count: Number(r.request_count || 0),
          created_at: r.created_at,
          updated_at: r.updated_at,
        }));
      }

      const keyRows = this.sqliteDb.prepare('SELECT * FROM api_keys').all();
      if (keyRows && keyRows.length > 0) {
        this.data.api_keys = keyRows.map((k: any) => ({
          id: k.id,
          name: k.name,
          key_prefix: k.key_prefix,
          key_hash: k.key_hash,
          enabled: Boolean(k.enabled),
          allowed_models: JSON.parse(k.allowed_models || '[]'),
          rpm_limit: Number(k.rpm_limit || 60),
          concurrent_limit: Number(k.concurrent_limit || 5),
          daily_request_limit: Number(k.daily_request_limit || 5000),
          expires_at: k.expires_at || null,
          created_at: k.created_at,
          last_used_at: k.last_used_at || null,
        }));
      }

      const logRows = this.sqliteDb.prepare('SELECT * FROM request_logs ORDER BY created_at DESC LIMIT 1000').all();
      if (logRows && logRows.length > 0) {
        this.data.request_logs = logRows.map((l: any) => ({
          request_id: l.request_id,
          api_key_id: l.api_key_id,
          account_id: l.account_id,
          model: l.model,
          status: Number(l.status),
          latency_ms: Number(l.latency_ms),
          error_code: l.error_code || null,
          created_at: l.created_at,
        }));
      }

      const convRows = this.sqliteDb.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
      if (convRows && convRows.length > 0) {
        this.data.conversations = convRows.map((c: any) => ({
          id: c.id,
          title: c.title,
          model: c.model,
          account_id: c.account_id,
          upstream_cid: c.upstream_cid || undefined,
          upstream_rid: c.upstream_rid || undefined,
          upstream_rcid: c.upstream_rcid || undefined,
          api_key_id: c.api_key_id || '',
          created_at: c.created_at,
          updated_at: c.updated_at,
        }));
      }

      const msgRows = this.sqliteDb.prepare('SELECT * FROM messages ORDER BY created_at ASC').all();
      if (msgRows && msgRows.length > 0) {
        this.data.messages = msgRows.map((m: any) => ({
          id: m.id,
          conversation_id: m.conversation_id,
          role: m.role,
          content: m.content,
          reasoning_content: m.reasoning_content || undefined,
          attachments: JSON.parse(m.attachments || '[]'),
          generated_media: JSON.parse(m.generated_media || '[]'),
          created_at: m.created_at,
        }));
      }

      const mediaRows = this.sqliteDb.prepare('SELECT * FROM media_cache ORDER BY created_at DESC LIMIT 500').all();
      if (mediaRows && mediaRows.length > 0) {
        this.data.media_cache = mediaRows.map((m: any) => ({
          id: m.id,
          account_id: m.account_id,
          upstream_url: m.upstream_url,
          mime_type: m.mime_type,
          file_name: m.file_name,
          data_b64: m.data_b64,
          created_at: m.created_at,
        }));
      }

      this.isSqliteReady = true;
      console.log(
        `[Database] SQLite ready. Loaded ${this.data.accounts.length} accounts, ${this.data.api_keys.length} API keys, and ${this.data.conversations.length} conversations from gateway.db.`
      );
    } catch (err) {
      console.error('[Database] Failed to initialize SQLite database:', err);
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

        // Postgres column migrations
        await client.query(`
          ALTER TABLE accounts ADD COLUMN IF NOT EXISTS proxy_url TEXT;
          ALTER TABLE accounts ADD COLUMN IF NOT EXISTS profile_dir TEXT;
          ALTER TABLE accounts ADD COLUMN IF NOT EXISTS user_agent TEXT;
          ALTER TABLE accounts ADD COLUMN IF NOT EXISTS locale VARCHAR(32) DEFAULT 'en-US';
          ALTER TABLE accounts ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'America/New_York';
          ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_keepalive_at TIMESTAMPTZ;
          ALTER TABLE accounts ADD COLUMN IF NOT EXISTS keepalive_status VARCHAR(32) DEFAULT 'IDLE';
        `);

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
            proxy_url: r.proxy_url || null,
            profile_dir: r.profile_dir || null,
            user_agent: r.user_agent || null,
            locale: r.locale || 'en-US',
            timezone: r.timezone || 'America/New_York',
            last_keepalive_at: r.last_keepalive_at ? new Date(r.last_keepalive_at).toISOString() : null,
            keepalive_status: r.keepalive_status || 'IDLE',
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
      console.warn('[Database] PostgreSQL connection failed, falling back to local SQLite:', err);
      this.isPgReady = false;
      this.initializeSqlite();
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

    if (this.isSqliteReady && this.sqliteDb) {
      try {
        this.sqliteDb
          .prepare(
            `INSERT INTO accounts (
              id, name, email_label, encrypted_cookie, auth_user, status, priority, weight, supported_models,
              proxy_url, profile_dir, user_agent, locale, timezone, last_keepalive_at, keepalive_status,
              last_success_at, last_error_at, last_error, cooldown_until, consecutive_errors, request_count,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            account.id,
            account.name,
            account.email_label,
            account.encrypted_cookie,
            account.auth_user,
            account.status,
            account.priority,
            account.weight,
            JSON.stringify(account.supported_models),
            account.proxy_url || null,
            account.profile_dir || null,
            account.user_agent || null,
            account.locale || 'en-US',
            account.timezone || 'America/New_York',
            account.last_keepalive_at || null,
            account.keepalive_status || 'IDLE',
            account.last_success_at || null,
            account.last_error_at || null,
            account.last_error || null,
            account.cooldown_until || null,
            account.consecutive_errors || 0,
            account.request_count || 0,
            account.created_at,
            account.updated_at
          );
      } catch (err) {
        console.error('[Database] SQLite insert account error:', err);
      }
    }

    if (this.isPgReady && this.pgPool) {
      this.pgPool
        .query(
          `INSERT INTO accounts (
            id, name, email_label, encrypted_cookie, auth_user, status, priority, weight, supported_models,
            proxy_url, profile_dir, user_agent, locale, timezone, last_keepalive_at, keepalive_status,
            last_success_at, last_error_at, last_error, cooldown_until, consecutive_errors, request_count,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
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
            account.proxy_url || null,
            account.profile_dir || null,
            account.user_agent || null,
            account.locale || 'en-US',
            account.timezone || 'America/New_York',
            account.last_keepalive_at || null,
            account.keepalive_status || 'IDLE',
            account.last_success_at || null,
            account.last_error_at || null,
            account.last_error || null,
            account.cooldown_until || null,
            account.consecutive_errors || 0,
            account.request_count || 0,
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

    if (this.isSqliteReady && this.sqliteDb) {
      try {
        this.sqliteDb
          .prepare(
            `UPDATE accounts SET
              name = ?, email_label = ?, encrypted_cookie = ?, auth_user = ?, status = ?, priority = ?, weight = ?, supported_models = ?,
              proxy_url = ?, profile_dir = ?, user_agent = ?, locale = ?, timezone = ?, last_keepalive_at = ?, keepalive_status = ?,
              last_success_at = ?, last_error_at = ?, last_error = ?, cooldown_until = ?, consecutive_errors = ?, request_count = ?, updated_at = ?
            WHERE id = ?`
          )
          .run(
            acc.name,
            acc.email_label,
            acc.encrypted_cookie,
            acc.auth_user,
            acc.status,
            acc.priority,
            acc.weight,
            JSON.stringify(acc.supported_models),
            acc.proxy_url || null,
            acc.profile_dir || null,
            acc.user_agent || null,
            acc.locale || 'en-US',
            acc.timezone || 'America/New_York',
            acc.last_keepalive_at || null,
            acc.keepalive_status || 'IDLE',
            acc.last_success_at,
            acc.last_error_at,
            acc.last_error,
            acc.cooldown_until,
            acc.consecutive_errors,
            acc.request_count,
            acc.updated_at,
            id
          );
      } catch (err) {
        console.error('[Database] SQLite update account error:', err);
      }
    }

    if (this.isPgReady && this.pgPool) {
      this.pgPool
        .query(
          `UPDATE accounts SET
            name = $1,
            email_label = $2,
            encrypted_cookie = $3,
            auth_user = $4,
            status = $5,
            priority = $6,
            weight = $7,
            supported_models = $8,
            proxy_url = $9,
            profile_dir = $10,
            user_agent = $11,
            locale = $12,
            timezone = $13,
            last_keepalive_at = $14,
            keepalive_status = $15,
            last_success_at = $16,
            last_error_at = $17,
            last_error = $18,
            cooldown_until = $19,
            consecutive_errors = $20,
            request_count = $21,
            updated_at = $22
          WHERE id = $23`,
          [
            acc.name,
            acc.email_label,
            acc.encrypted_cookie,
            acc.auth_user,
            acc.status,
            acc.priority,
            acc.weight,
            JSON.stringify(acc.supported_models),
            acc.proxy_url || null,
            acc.profile_dir || null,
            acc.user_agent || null,
            acc.locale || 'en-US',
            acc.timezone || 'America/New_York',
            acc.last_keepalive_at || null,
            acc.keepalive_status || 'IDLE',
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
      if (this.isSqliteReady && this.sqliteDb) {
        try {
          this.sqliteDb.prepare('DELETE FROM accounts WHERE id = ?').run(id);
        } catch (err) {
          console.error('[Database] SQLite delete account error:', err);
        }
      }
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

    if (this.isSqliteReady && this.sqliteDb) {
      try {
        this.sqliteDb
          .prepare(
            `INSERT INTO api_keys (id, name, key_prefix, key_hash, enabled, allowed_models, rpm_limit, concurrent_limit, daily_request_limit, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            key.id,
            key.name,
            key.key_prefix,
            key.key_hash,
            key.enabled ? 1 : 0,
            JSON.stringify(key.allowed_models),
            key.rpm_limit,
            key.concurrent_limit,
            key.daily_request_limit,
            key.expires_at,
            key.created_at
          );
      } catch (err) {
        console.error('[Database] SQLite insert api_key error:', err);
      }
    }

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

    if (this.isSqliteReady && this.sqliteDb) {
      try {
        this.sqliteDb
          .prepare(
            `UPDATE api_keys SET
              name = ?, enabled = ?, allowed_models = ?, rpm_limit = ?, concurrent_limit = ?, daily_request_limit = ?, expires_at = ?, last_used_at = ?
            WHERE id = ?`
          )
          .run(
            key.name,
            key.enabled ? 1 : 0,
            JSON.stringify(key.allowed_models),
            key.rpm_limit,
            key.concurrent_limit,
            key.daily_request_limit,
            key.expires_at,
            key.last_used_at,
            id
          );
      } catch (err) {
        console.error('[Database] SQLite update api_key error:', err);
      }
    }

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
      if (this.isSqliteReady && this.sqliteDb) {
        try {
          this.sqliteDb.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
        } catch (err) {
          console.error('[Database] SQLite delete api_key error:', err);
        }
      }
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

    if (this.isSqliteReady && this.sqliteDb) {
      try {
        this.sqliteDb
          .prepare(
            `INSERT INTO request_logs (request_id, api_key_id, account_id, model, status, latency_ms, error_code, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            log.request_id,
            log.api_key_id,
            log.account_id,
            log.model,
            log.status,
            log.latency_ms,
            log.error_code,
            log.created_at
          );
      } catch (err) {
        console.error('[Database] SQLite insert request_log error:', err);
      }
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

    if (this.isSqliteReady && this.sqliteDb) {
      try {
        this.sqliteDb
          .prepare(
            `INSERT INTO account_events (id, account_id, event_type, from_status, to_status, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            event.id,
            event.account_id,
            event.event_type,
            event.from_status,
            event.to_status,
            event.reason,
            event.created_at
          );
      } catch (err) {
        console.error('[Database] SQLite insert account_event error:', err);
      }
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

  // --- CONVERSATIONS ---
  public createConversation(conv: Conversation): void {
    this.data.conversations.unshift(conv);

    if (this.isSqliteReady && this.sqliteDb) {
      try {
        const stmt = this.sqliteDb.prepare(`
          INSERT INTO conversations (id, title, model, account_id, upstream_cid, upstream_rid, upstream_rcid, api_key_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          conv.id,
          conv.title,
          conv.model,
          conv.account_id,
          conv.upstream_cid || null,
          conv.upstream_rid || null,
          conv.upstream_rcid || null,
          conv.api_key_id,
          conv.created_at,
          conv.updated_at
        );
      } catch (err) {
        console.error('[Database] SQLite insert conversation error:', err);
      }
    }

    if (this.isPgReady && this.pgPool) {
      this.pgPool
        .query(
          `INSERT INTO conversations (id, title, model, account_id, upstream_cid, upstream_rid, upstream_rcid, api_key_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            conv.id,
            conv.title,
            conv.model,
            conv.account_id,
            conv.upstream_cid || null,
            conv.upstream_rid || null,
            conv.upstream_rcid || null,
            conv.api_key_id,
            conv.created_at,
            conv.updated_at,
          ]
        )
        .catch((err) => console.error('[Database] Postgres insert conversation error:', err));
    }
  }

  public getConversation(id: string): Conversation | undefined {
    return this.data.conversations.find((c) => c.id === id);
  }

  public listConversations(apiKeyId?: string): Conversation[] {
    if (!apiKeyId) return [...this.data.conversations];
    return this.data.conversations.filter((c) => c.api_key_id === apiKeyId);
  }

  public updateConversation(id: string, updates: Partial<Conversation>): void {
    const idx = this.data.conversations.findIndex((c) => c.id === id);
    if (idx !== -1) {
      this.data.conversations[idx] = {
        ...this.data.conversations[idx],
        ...updates,
        updated_at: new Date().toISOString(),
      };
      const conv = this.data.conversations[idx];

      if (this.isSqliteReady && this.sqliteDb) {
        try {
          const stmt = this.sqliteDb.prepare(`
            UPDATE conversations
            SET title = ?, model = ?, account_id = ?, upstream_cid = ?, upstream_rid = ?, upstream_rcid = ?, updated_at = ?
            WHERE id = ?
          `);
          stmt.run(
            conv.title,
            conv.model,
            conv.account_id,
            conv.upstream_cid || null,
            conv.upstream_rid || null,
            conv.upstream_rcid || null,
            conv.updated_at,
            id
          );
        } catch (err) {
          console.error('[Database] SQLite update conversation error:', err);
        }
      }

      if (this.isPgReady && this.pgPool) {
        this.pgPool
          .query(
            `UPDATE conversations
             SET title = $1, model = $2, account_id = $3, upstream_cid = $4, upstream_rid = $5, upstream_rcid = $6, updated_at = $7
             WHERE id = $8`,
            [
              conv.title,
              conv.model,
              conv.account_id,
              conv.upstream_cid || null,
              conv.upstream_rid || null,
              conv.upstream_rcid || null,
              conv.updated_at,
              id,
            ]
          )
          .catch((err) => console.error('[Database] Postgres update conversation error:', err));
      }
    }
  }

  public deleteConversation(id: string): void {
    this.data.conversations = this.data.conversations.filter((c) => c.id !== id);
    this.data.messages = this.data.messages.filter((m) => m.conversation_id !== id);

    if (this.isSqliteReady && this.sqliteDb) {
      try {
        this.sqliteDb.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
        this.sqliteDb.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      } catch (err) {
        console.error('[Database] SQLite delete conversation error:', err);
      }
    }

    if (this.isPgReady && this.pgPool) {
      this.pgPool
        .query('DELETE FROM conversations WHERE id = $1', [id])
        .catch((err) => console.error('[Database] Postgres delete conversation error:', err));
    }
  }

  // --- MESSAGES ---
  public createMessage(msg: Message): void {
    this.data.messages.push(msg);
    if (this.data.messages.length > 5000) {
      this.data.messages = this.data.messages.slice(-5000);
    }

    if (this.isSqliteReady && this.sqliteDb) {
      try {
        const stmt = this.sqliteDb.prepare(`
          INSERT INTO messages (id, conversation_id, role, content, reasoning_content, attachments, generated_media, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          msg.id,
          msg.conversation_id,
          msg.role,
          msg.content,
          msg.reasoning_content || null,
          JSON.stringify(msg.attachments || []),
          JSON.stringify(msg.generated_media || []),
          msg.created_at
        );
      } catch (err) {
        console.error('[Database] SQLite insert message error:', err);
      }
    }

    if (this.isPgReady && this.pgPool) {
      this.pgPool
        .query(
          `INSERT INTO messages (id, conversation_id, role, content, reasoning_content, attachments, generated_media, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            msg.id,
            msg.conversation_id,
            msg.role,
            msg.content,
            msg.reasoning_content || null,
            JSON.stringify(msg.attachments || []),
            JSON.stringify(msg.generated_media || []),
            msg.created_at,
          ]
        )
        .catch((err) => console.error('[Database] Postgres insert message error:', err));
    }
  }

  public listMessages(conversationId: string): Message[] {
    return this.data.messages.filter((m) => m.conversation_id === conversationId);
  }

  // --- MEDIA CACHE ---
  public saveMediaCache(media: MediaCache): void {
    const existingIdx = this.data.media_cache.findIndex((m) => m.id === media.id);
    if (existingIdx !== -1) {
      this.data.media_cache[existingIdx] = media;
    } else {
      this.data.media_cache.unshift(media);
    }

    if (this.isSqliteReady && this.sqliteDb) {
      try {
        const stmt = this.sqliteDb.prepare(`
          INSERT OR REPLACE INTO media_cache (id, account_id, upstream_url, mime_type, file_name, data_b64, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          media.id,
          media.account_id,
          media.upstream_url,
          media.mime_type,
          media.file_name,
          media.data_b64,
          media.created_at
        );
      } catch (err) {
        console.error('[Database] SQLite insert media_cache error:', err);
      }
    }

    if (this.isPgReady && this.pgPool) {
      this.pgPool
        .query(
          `INSERT INTO media_cache (id, account_id, upstream_url, mime_type, file_name, data_b64, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET data_b64 = EXCLUDED.data_b64`,
          [
            media.id,
            media.account_id,
            media.upstream_url,
            media.mime_type,
            media.file_name,
            media.data_b64,
            media.created_at,
          ]
        )
        .catch((err) => console.error('[Database] Postgres insert media_cache error:', err));
    }
  }

  public getMediaCache(id: string): MediaCache | undefined {
    return this.data.media_cache.find((m) => m.id === id);
  }

  // --- METRICS ---
  public getAnalytics() {

    const totalRequests = this.data.request_logs.length;
    const successfulRequests = this.data.request_logs.filter((l) => l.status >= 200 && l.status < 400).length;
    const errorRequests = totalRequests - successfulRequests;
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
