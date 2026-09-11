import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { accountManager } from '../services/account-manager.js';
import { apiKeyManager } from '../services/api-key-manager.js';
import { usageService } from '../services/usage-service.js';
import { db } from '../db/database.js';
import { config } from '../config.js';
import { validateGeminiCookie } from '../utils/cookie.js';

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
  // 1. Check HttpOnly session cookie
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

  // 2. Check programmatic header authentication (API keys/tokens for curl/scripts)
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

adminRouter.post('/accounts', (req: Request, res: Response) => {
  try {
    const { name, email_label, cookie, auth_user, priority, weight, supported_models } = req.body;
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
    });

    return res.status(201).json({ account: created });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to create account' });
  }
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

adminRouter.delete('/accounts/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const success = accountManager.deleteAccount(id);
  if (!success) {
    return res.status(404).json({ error: 'Account not found' });
  }
  return res.json({ success: true });
});

// --- API KEYS ---
adminRouter.get('/api-keys', (req: Request, res: Response) => {
  const keys = apiKeyManager.listApiKeys();
  res.json({ keys });
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
