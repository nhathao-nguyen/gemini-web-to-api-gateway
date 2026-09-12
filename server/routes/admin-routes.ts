import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { accountManager } from '../services/account-manager.js';
import { apiKeyManager } from '../services/api-key-manager.js';
import { accountScheduler } from '../services/scheduler.js';
import { usageService } from '../services/usage-service.js';
import { db } from '../db/database.js';
import { config } from '../config.js';
import { validateGeminiCookie } from '../utils/cookie.js';
import { geminiProvider } from '../services/gemini-adapter/index.js';
import { browserOnboardingService } from '../services/browser-manager/onboarding-service.js';
import { keepAliveWorker } from '../services/browser-manager/keepalive-worker.js';
import { testProxyConnection } from '../services/browser-manager/stealth-factory.js';

export const adminRouter = Router();

// In-memory session store for authenticated admin sessions
interface AdminSession {
  token: string;
  createdAt: number;
  expiresAt: number;
  csrfToken: string;
}

const adminSessions = new Map<string, AdminSession>();

function createAdminSession(): AdminSession {
  const token = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const session: AdminSession = {
    token,
    createdAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000, // 24 hours
    csrfToken,
  };
  adminSessions.set(token, session);
  return session;
}

function getAdminSession(token?: string): AdminSession | null {
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return null;
  }
  return session;
}

function parseCookieHeader(header?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  const parts = header.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx !== -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      cookies[k] = decodeURIComponent(v);
    }
  }
  return cookies;
}

// Public endpoint to check auth requirements
adminRouter.get('/auth-status', (req: Request, res: Response) => {
  const requiresAuth = Boolean(config.adminApiKey || config.adminPassword || config.isProduction);
  res.json({
    requiresAuth,
    hasConfiguredKey: Boolean(config.adminApiKey || config.adminPassword),
  });
});

// Public endpoint to check current admin session status
adminRouter.get('/auth/session', (req: Request, res: Response) => {
  const cookies = parseCookieHeader(req.headers.cookie);
  const sessionToken = cookies['admin_session'];
  const session = getAdminSession(sessionToken);

  if (session) {
    return res.json({
      authenticated: true,
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }

  return res.json({
    authenticated: false,
  });
});

// Public endpoint to login and obtain HttpOnly session cookie
adminRouter.post('/auth/login', (req: Request, res: Response) => {
  const credential = (
    req.body.credential ||
    req.body.password ||
    req.body.key ||
    req.body.adminSecret ||
    ''
  ).trim();

  const isPasswordValid = Boolean(config.adminPassword && credential === config.adminPassword);
  const isKeyValid = Boolean(config.adminApiKey && credential === config.adminApiKey);

  if (!isPasswordValid && !isKeyValid) {
    return res.status(401).json({
      success: false,
      error: 'Invalid admin credentials',
    });
  }

  const session = createAdminSession();
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const secureFlag = isHttps ? '; Secure' : '';
  const cookieHeader = `admin_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureFlag}`;

  res.setHeader('Set-Cookie', cookieHeader);
  return res.json({
    success: true,
    authenticated: true,
    csrfToken: session.csrfToken,
  });
});

// Public endpoint to logout and invalidate session
adminRouter.post('/auth/logout', (req: Request, res: Response) => {
  const cookies = parseCookieHeader(req.headers.cookie);
  const sessionToken = cookies['admin_session'];
  if (sessionToken) {
    adminSessions.delete(sessionToken);
  }

  res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return res.json({
    success: true,
    authenticated: false,
  });
});

// Protected admin authentication middleware
function adminAuth(req: Request, res: Response, next: () => void) {
  // 1. Check programmatic header authentication first (allows scripts/tools with secret to bypass cookie CSRF)
  const authHeader = req.headers['authorization'];
  const adminSecret =
    req.headers['x-admin-key'] ||
    req.headers['x-admin-password'] ||
    (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader);

  if (config.adminApiKey && adminSecret === config.adminApiKey) {
    return next();
  }
  if (config.adminPassword && adminSecret === config.adminPassword) {
    return next();
  }

  // 2. Check HttpOnly session cookie
  const cookies = parseCookieHeader(req.headers.cookie);
  const sessionToken = cookies['admin_session'];
  const session = getAdminSession(sessionToken);

  if (session) {
    // CSRF verification for state-mutating requests when using cookie-based auth
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase());
    if (isMutation) {
      const csrfHeader = req.headers['x-csrf-token'];
      if (!csrfHeader || csrfHeader !== session.csrfToken) {
        return res.status(403).json({
          error: 'CSRF validation failed: Missing or invalid X-CSRF-Token header.',
        });
      }
    }
    (req as any).adminSession = session;
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized admin access. Please authenticate via /api/admin/auth/login or provide X-Admin-Key.',
  });
}

adminRouter.use(adminAuth);

// Helper endpoint for pre-validating cookie string
adminRouter.post('/validate-cookie', (req: Request, res: Response) => {
  const { cookie } = req.body;
  if (!cookie) {
    return res.status(400).json({ valid: false, error: 'Cookie string is required' });
  }
  const result = validateGeminiCookie(cookie);
  return res.json(result);
});

// --- ACCOUNTS ---
adminRouter.get('/accounts', (req: Request, res: Response) => {
  const accounts = accountManager.listAccounts();
  res.json({ accounts });
});

adminRouter.get('/accounts/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const account = accountManager.getAccount(id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }
  const { encrypted_cookie, ...safe } = account;
  return res.json({ account: safe });
});

adminRouter.post('/accounts', (req: Request, res: Response) => {
  try {
    const { name, email_label, cookie, auth_user, priority, weight, supported_models, proxy_url } = req.body;
    if (!name || !email_label || !cookie) {
      return res.status(400).json({ error: 'Name, email_label, and cookie are required' });
    }

    const created = accountManager.createAccount({
      name,
      email_label,
      cookie,
      auth_user: auth_user || '0',
      priority: priority ? parseInt(priority, 10) : 10,
      weight: weight ? parseInt(weight, 10) : 1,
      supported_models: Array.isArray(supported_models) ? supported_models : undefined,
      proxy_url: proxy_url ? proxy_url.trim() : undefined,
    });

    return res.status(201).json({ account: created });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to create account' });
  }
});

adminRouter.patch('/accounts/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, email_label, priority, weight, supported_models, proxy_url } = req.body;

  const updates: any = {};
  if (name !== undefined) updates.name = name.trim();
  if (email_label !== undefined) updates.email_label = email_label.trim();
  if (priority !== undefined) updates.priority = parseInt(priority, 10);
  if (weight !== undefined) updates.weight = parseInt(weight, 10);
  if (supported_models !== undefined && Array.isArray(supported_models)) updates.supported_models = supported_models;
  if (proxy_url !== undefined) updates.proxy_url = proxy_url ? proxy_url.trim() : null;

  const updated = accountManager.updateAccount(id, updates);
  if (!updated) {
    return res.status(404).json({ error: 'Account not found' });
  }

  return res.json({ account: updated });
});

adminRouter.post('/accounts/:id/cookie', (req: Request, res: Response) => {
  const { id } = req.params;
  const { cookie } = req.body;
  if (!cookie) {
    return res.status(400).json({ error: 'Cookie string is required' });
  }

  const success = accountManager.replaceCookie(id, cookie);
  if (!success) {
    return res.status(404).json({ error: 'Account not found' });
  }

  return res.json({ success: true, message: 'Session cookie updated and encrypted' });
});

adminRouter.patch('/accounts/:id/status', (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, reason } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'Status is required' });
  }

  const success = accountManager.setStatus(id, status, reason);
  if (!success) {
    return res.status(404).json({ error: 'Account not found' });
  }

  return res.json({ success: true });
});

adminRouter.post('/accounts/:id/test', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await accountManager.testSession(id);
  return res.json(result);
});

adminRouter.post('/accounts/:id/keepalive', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await keepAliveWorker.refreshAccount(id);
  if (!result.success) {
    return res.status(400).json(result);
  }
  return res.json(result);
});

adminRouter.post('/accounts/:id/discover-models', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await accountManager.testSession(id);
  if (result.valid && result.models) {
    return res.json({ success: true, models: result.models });
  }
  return res.status(400).json({ success: false, error: result.error || 'Failed to discover models' });
});

adminRouter.get('/accounts/:id/quota', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const quota = await accountManager.getAccountQuota(id);
    return res.json({ success: true, quota });
  } catch (err: any) {
    return res.status(err.message?.includes('not found') ? 404 : 500).json({
      success: false,
      error: err.message || 'Failed to fetch account quota',
    });
  }
});

adminRouter.delete('/accounts/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const success = accountManager.deleteAccount(id);
  if (!success) {
    return res.status(404).json({ error: 'Account not found' });
  }
  return res.json({ success: true });
});

// --- KEEPALIVE & PROXY MANAGEMENT ---
adminRouter.get('/keepalive/status', (req: Request, res: Response) => {
  return res.json(keepAliveWorker.getStatus());
});

adminRouter.post('/proxy/test', async (req: Request, res: Response) => {
  const { proxy_url } = req.body;
  if (!proxy_url) {
    return res.status(400).json({ success: false, error: 'Proxy URL is required' });
  }
  const result = await testProxyConnection(proxy_url);
  return res.json(result);
});

// --- BROWSER HEADED ONBOARDING ---
adminRouter.post('/browser-onboard/start', async (req: Request, res: Response) => {
  try {
    const { accountId, name, emailLabel, proxyUrl, priority, weight } = req.body;
    const session = await browserOnboardingService.startSession({
      accountId,
      name,
      emailLabel,
      proxyUrl,
      priority: priority ? parseInt(priority, 10) : undefined,
      weight: weight ? parseInt(weight, 10) : undefined,
    });
    return res.status(201).json({ session });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to start browser onboarding' });
  }
});

adminRouter.get('/browser-onboard/status/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = browserOnboardingService.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Onboarding session not found or expired' });
  }
  return res.json({ session });
});

adminRouter.post('/browser-onboard/cancel/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const success = await browserOnboardingService.cancelSession(sessionId);
  return res.json({ success });
});

// --- API KEYS ---
adminRouter.get('/api-keys', (req: Request, res: Response) => {
  const keys = apiKeyManager.listApiKeys();
  res.json({ keys });
});

adminRouter.get('/api-keys/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const key = apiKeyManager.getApiKey(id);
  if (!key) {
    return res.status(404).json({ error: 'API key not found' });
  }
  return res.json({ keyRecord: key });
});

adminRouter.post('/api-keys', (req: Request, res: Response) => {
  try {
    const { name, allowed_models, rpm_limit, concurrent_limit, daily_request_limit, expires_in_days } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Key name is required' });
    }

    const { keyRecord, plainApiKey } = apiKeyManager.createApiKey({
      name,
      allowed_models: Array.isArray(allowed_models) ? allowed_models : ['*'],
      rpm_limit: rpm_limit ? parseInt(rpm_limit, 10) : 60,
      concurrent_limit: concurrent_limit ? parseInt(concurrent_limit, 10) : 5,
      daily_request_limit: daily_request_limit ? parseInt(daily_request_limit, 10) : 5000,
      expires_in_days: expires_in_days ? parseInt(expires_in_days, 10) : undefined,
    });

    return res.status(201).json({
      apiKey: plainApiKey, // Displayed ONLY once here
      keyRecord,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to create API key' });
  }
});

adminRouter.patch('/api-keys/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const updated = apiKeyManager.updateApiKey(id, req.body);
  if (!updated) {
    return res.status(404).json({ error: 'API key not found' });
  }
  return res.json({ keyRecord: updated });
});

adminRouter.delete('/api-keys/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const success = apiKeyManager.deleteApiKey(id);
  if (!success) {
    return res.status(404).json({ error: 'API key not found' });
  }
  return res.json({ success: true });
});

// --- ANALYTICS & LOGS ---
adminRouter.get('/analytics', (req: Request, res: Response) => {
  const analytics = usageService.getAnalytics();
  res.json(analytics);
});

adminRouter.get('/logs', (req: Request, res: Response) => {
  const logs = usageService.getRecentLogs(100);
  res.json({ logs });
});

adminRouter.get('/events', (req: Request, res: Response) => {
  const events = db.getAccountEvents(100);
  res.json({ events });
});

// --- MODELS DISCOVERY (Admin) ---
adminRouter.get('/models', (req: Request, res: Response) => {
  const models = accountScheduler.getAvailableModels();
  res.json({ models });
});

// --- SYSTEM & SETTINGS ---
adminRouter.get('/settings', (req: Request, res: Response) => {
  const isDbConnected = config.databaseUrl
    ? db.isPostgresConnected()
    : db.isSqliteConnected();
  res.json({
    port: config.port,
    host: config.host,
    requestTimeout: config.requestTimeout,
    maxUpstreamAttempts: config.maxUpstreamAttempts,
    logLevel: config.logLevel,
    corsOrigins: config.corsOrigins,
    isProduction: config.isProduction,
    databaseEngine: config.databaseUrl ? 'PostgreSQL' : 'SQLite',
    isDatabaseConnected: isDbConnected,
    hasRedis: Boolean(config.redisUrl),
    requiresAuth: Boolean(config.adminApiKey || config.adminPassword || config.isProduction),
    uptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version,
    platform: process.platform,
  });
});

// --- UPSTREAM CONVERSATIONS (Gemini Web) ---
adminRouter.get('/conversations/upstream-recent', async (req: Request, res: Response) => {
  const accountId = req.query.account_id as string | undefined;
  const accounts = db.getAccounts();
  const targetAccount = accountId
    ? accounts.find((a) => a.id === accountId)
    : accounts.find((a) => a.status === 'ACTIVE') || accounts[0];

  if (!targetAccount) {
    return res.status(503).json({ error: 'No active Gemini account found' });
  }

  try {
    const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit || '10'), 10)));
    const conversations = await geminiProvider.fetchRecentConversations(targetAccount, limit);
    return res.json({
      account_id: targetAccount.id,
      account_name: targetAccount.name,
      conversations,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch recent conversations' });
  }
});

adminRouter.get('/conversations/upstream/:cid/turns', async (req: Request, res: Response) => {
  const cid = req.params.cid;
  const accountId = req.query.account_id as string | undefined;
  const accounts = db.getAccounts();
  const targetAccount = accountId
    ? accounts.find((a) => a.id === accountId)
    : accounts.find((a) => a.status === 'ACTIVE') || accounts[0];

  if (!targetAccount) {
    return res.status(503).json({ error: 'No active Gemini account found' });
  }

  try {
    const data = await geminiProvider.fetchConversationHistory(targetAccount, cid);
    return res.json({
      conversation_id: cid,
      account_id: targetAccount.id,
      turns: data.turns,
      last_rid: data.lastRid,
      last_rcid: data.lastRcid,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch conversation history' });
  }
});


