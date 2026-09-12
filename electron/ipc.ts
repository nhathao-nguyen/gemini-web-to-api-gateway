import { ipcMain } from 'electron';
import { accountManager } from '../server/services/account-manager.js';
import { apiKeyManager } from '../server/services/api-key-manager.js';
import { accountScheduler } from '../server/services/scheduler.js';
import { quotaManager } from '../server/services/quota-manager.js';
import { usageService } from '../server/services/usage-service.js';
import { keepAliveWorker } from '../server/services/browser-manager/keepalive-worker.js';
import { testProxyConnection } from '../server/services/browser-manager/stealth-factory.js';
import { geminiProvider } from '../server/services/gemini-adapter/index.js';
import { validateGeminiCookie } from '../server/utils/cookie.js';
import { db } from '../server/db/database.js';
import { config } from '../server/config.js';
import { loadAppConfig, saveAppConfig } from './app-config.js';

export interface IpcSuccess {
  ok: true;
  data: any;
}

export interface IpcFailure {
  ok: false;
  error: string;
  code?: string;
}

export type IpcResult = IpcSuccess | IpcFailure;

const ok = (data: any = {}): IpcResult => ({ ok: true, data });
const fail = (error: string, code?: string): IpcResult => ({ ok: false, error, code });
const asError = (err: any, fallback: string) => (err?.message ? String(err.message) : fallback);

type Handler = (args: any) => Promise<any> | any;

function wrap(handler: Handler): (event: any, args: any) => Promise<IpcResult> {
  return async (_event, args) => {
    try {
      return ok(await handler(args || {}));
    } catch (err: any) {
      const msg = asError(err, 'Internal desktop bridge error');
      const code = msg.includes('not found') || msg.includes('NOT_FOUND') ? 'NOT_FOUND' : undefined;
      return fail(msg, code);
    }
  };
}

export function registerIpcHandlers(userDataDir: string, gateway: { url: string }): void {
  const handlers: Record<string, Handler> = {
    // ---------- accounts ----------
    'accounts:list': () => ({ accounts: accountManager.listAccounts() }),
    'accounts:get': ({ id }: any) => {
      const account = accountManager.getAccount(id);
      if (!account) throw new Error(`NOT_FOUND: Account ${id} not found`);
      const { encrypted_cookie, ...safe } = account;
      return { account: safe };
    },
    'accounts:create': ({ name, email_label, cookie, auth_user, priority, weight, supported_models, proxy_url }: any) => {
      if (!name || !email_label || !cookie) throw new Error('Name, email_label, and cookie are required');
      const account = accountManager.createAccount({
        name,
        email_label,
        cookie,
        auth_user: auth_user || '0',
        priority: priority ? parseInt(priority, 10) : 10,
        weight: weight ? parseInt(weight, 10) : 1,
        supported_models: Array.isArray(supported_models) ? supported_models : undefined,
        proxy_url: proxy_url ? String(proxy_url).trim() : undefined,
      });
      return { account };
    },
    'accounts:update': ({ id, updates }: any) => {
      const clean: any = {};
      const src = updates || {};
      if (src.name !== undefined) clean.name = String(src.name).trim();
      if (src.email_label !== undefined) clean.email_label = String(src.email_label).trim();
      if (src.priority !== undefined) clean.priority = parseInt(src.priority, 10);
      if (src.weight !== undefined) clean.weight = parseInt(src.weight, 10);
      if (src.supported_models !== undefined && Array.isArray(src.supported_models)) clean.supported_models = src.supported_models;
      if (src.proxy_url !== undefined) clean.proxy_url = src.proxy_url ? String(src.proxy_url).trim() : null;
      if (src.auth_user !== undefined) clean.auth_user = String(src.auth_user).trim();
      const account = accountManager.updateAccount(id, clean);
      if (!account) throw new Error(`NOT_FOUND: Account ${id} not found`);
      return { account };
    },
    'accounts:replace-cookie': ({ id, cookie }: any) => {
      if (!cookie) throw new Error('Cookie string is required');
      const success = accountManager.replaceCookie(id, cookie);
      if (!success) throw new Error(`NOT_FOUND: Account ${id} not found`);
      return { success: true, message: 'Session cookie updated and encrypted' };
    },
    'accounts:set-status': ({ id, status, reason }: any) => {
      if (!status) throw new Error('Status is required');
      const success = accountManager.setStatus(id, status, reason || 'Updated via Desktop UI');
      if (!success) throw new Error(`NOT_FOUND: Account ${id} not found`);
      return { success: true };
    },
    'accounts:test-session': ({ id }: any) => accountManager.testSession(id),
    'accounts:discover-models': async ({ id }: any) => {
      const result = await accountManager.testSession(id);
      if (result.valid && (result as any).models) return { success: true, models: (result as any).models };
      throw new Error((result as any).error || 'Failed to discover models');
    },
    'accounts:quota': ({ id }: any) => accountManager.getAccountQuota(id).then((quota) => ({ success: true, quota })),
    'accounts:delete': ({ id }: any) => {
      const success = accountManager.deleteAccount(id);
      if (!success) throw new Error(`NOT_FOUND: Account ${id} not found`);
      return { success: true };
    },
    'accounts:validate-cookie': ({ cookie }: any) => {
      if (!cookie) throw new Error('Cookie string is required');
      return validateGeminiCookie(cookie);
    },

    // ---------- keepalive / proxy ----------
    'keepalive:status': () => keepAliveWorker.getStatus(),
    'keepalive:trigger': async ({ id }: any) => {
      const result = await keepAliveWorker.refreshAccount(id);
      if (!result.success) throw new Error(result.message || 'KeepAlive refresh failed');
      return result;
    },
    'proxy:test': ({ proxy_url }: any) => {
      if (!proxy_url) throw new Error('Proxy URL is required');
      return testProxyConnection(proxy_url);
    },

    // ---------- api keys (LAN quota pool sharing) ----------
    'keys:list': () => ({ keys: apiKeyManager.listApiKeys() }),
    'keys:get': ({ id }: any) => {
      const key = apiKeyManager.getApiKey(id);
      if (!key) throw new Error(`NOT_FOUND: API key ${id} not found`);
      return { keyRecord: key };
    },
    'keys:create': ({ name, allowed_models, rpm_limit, concurrent_limit, daily_request_limit, expires_in_days }: any) => {
      if (!name) throw new Error('Key name is required');
      const { keyRecord, plainApiKey } = apiKeyManager.createApiKey({
        name,
        allowed_models: Array.isArray(allowed_models) ? allowed_models : ['*'],
        rpm_limit: rpm_limit ? parseInt(rpm_limit, 10) : 60,
        concurrent_limit: concurrent_limit ? parseInt(concurrent_limit, 10) : 5,
        daily_request_limit: daily_request_limit ? parseInt(daily_request_limit, 10) : 5000,
        expires_in_days: expires_in_days ? parseInt(expires_in_days, 10) : undefined,
      });
      return { apiKey: plainApiKey, keyRecord };
    },
    'keys:update': ({ id, updates }: any) => {
      const keyRecord = apiKeyManager.updateApiKey(id, updates || {});
      if (!keyRecord) throw new Error(`NOT_FOUND: API key ${id} not found`);
      return { keyRecord };
    },
    'keys:delete': ({ id }: any) => {
      const success = apiKeyManager.deleteApiKey(id);
      if (!success) throw new Error(`NOT_FOUND: API key ${id} not found`);
      return { success: true };
    },

    // ---------- observability ----------
    analytics: () => usageService.getAnalytics(),
    logs: () => ({ logs: usageService.getRecentLogs(100) }),
    events: () => ({ events: db.getAccountEvents(100) }),
    models: () => ({ models: accountScheduler.getAvailableModels() }),
    settings: () => ({
      port: config.port,
      host: config.host,
      shareLan: config.shareLan,
      dataDir: config.dataDir,
      requestTimeout: config.requestTimeout,
      maxUpstreamAttempts: config.maxUpstreamAttempts,
      logLevel: config.logLevel,
      corsOrigins: config.corsOrigins,
      isProduction: config.isProduction,
      databaseEngine: 'SQLite',
      dbPath: db.getDbPath(),
      gatewayUrl: gateway.url,
      isDatabaseConnected: db.isSqliteConnected(),
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
    }),

    // ---------- desktop app config (LAN share toggle) ----------
    'app-config:get': () => ({ ...loadAppConfig(userDataDir), gatewayUrl: gateway.url, restartRequired: false }),
    'app-config:set': ({ shareLan, port }: any) => {
      const current = loadAppConfig(userDataDir);
      const next = saveAppConfig(userDataDir, {
        shareLan: shareLan ?? current.shareLan,
        port: port ?? current.port,
      });
      return { ...next, gatewayUrl: gateway.url, restartRequired: true };
    },

    // ---------- upstream conversations (stateless relay) ----------
    'conversations:recent': async ({ limit, account_id }: any) => {
      const accounts = db.getAccounts();
      const targetAccount = account_id
        ? accounts.find((a) => a.id === account_id && a.status === 'ACTIVE' && !quotaManager.isCoolingDown(a))
        : accountScheduler.selectAnyActiveAccount();
      if (!targetAccount) throw new Error('NO_HEALTHY_ACCOUNTS: No active Gemini account found');
      const safeLimit = Math.min(20, Math.max(1, parseInt(String(limit || '10'), 10)));
      const operationDeadline = Date.now() + (config.requestTimeout || 60000);
      const conversations = await geminiProvider.fetchRecentConversations(
        targetAccount,
        safeLimit,
        undefined,
        operationDeadline
      );
      for (const c of conversations) {
        if (c.id) accountScheduler.setConversationAffinity(c.id, targetAccount.id);
      }
      return {
        account_id: targetAccount.id,
        account_name: targetAccount.name,
        conversations: conversations.map((c) => ({ ...c, account_id: targetAccount.id })),
      };
    },
    'conversations:turns': async ({ cid, account_id }: any) => {
      let targetAccount = null;
      const affinityAccountId = accountScheduler.getConversationAffinity(cid);
      if (affinityAccountId) {
        const acc = db.getAccountById(affinityAccountId);
        if (!acc || acc.status !== 'ACTIVE' || quotaManager.isCoolingDown(acc)) {
          throw new Error(`CONVERSATION_ACCOUNT_UNAVAILABLE: Account ${affinityAccountId} is inactive`);
        }
        targetAccount = acc;
      } else if (account_id) {
        const acc = db.getAccountById(account_id);
        if (!acc || acc.status !== 'ACTIVE' || quotaManager.isCoolingDown(acc)) {
          throw new Error(`CONVERSATION_ACCOUNT_UNAVAILABLE: Account ${account_id} is inactive`);
        }
        targetAccount = acc;
      } else {
        targetAccount = accountScheduler.selectAnyActiveAccount();
      }
      if (!targetAccount) throw new Error('NO_HEALTHY_ACCOUNTS: No active Gemini account found');
      const operationDeadline = Date.now() + (config.requestTimeout || 60000);
      const data = await geminiProvider.fetchConversationHistory(targetAccount, cid, undefined, operationDeadline);
      accountScheduler.setConversationAffinity(cid, targetAccount.id);
      return {
        conversation_id: cid,
        account_id: targetAccount.id,
        turns: data.turns,
        last_rid: data.lastRid,
        last_rcid: data.lastRcid,
      };
    },
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(`gw:${channel}`, wrap(handler));
  }
}
