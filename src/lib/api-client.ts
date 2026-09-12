/**
 * Production-grade Admin API Client
 * - Relative URLs by default (works across localhost, LAN, reverse proxy, Docker, Cloud Run)
 * - HttpOnly session cookies (credentials: 'include')
 * - In-memory CSRF token handling
 * - Zero localStorage persistence for server data or sensitive secrets
 */

import {
  SafeAccount,
  ApiKeyItem,
  AnalyticsData,
  RequestLogItem,
  AccountEventItem,
  SystemSettings,
  AccountStatus,
  AccountQuotaInfo,
} from '../types/client.js';

// Optional external base URL; defaults to empty string so relative URLs are used
const metaEnv = ((import.meta as any)?.env || {}) as Record<string, string | undefined>;
const rawBaseUrl = (metaEnv.VITE_PUBLIC_BASE_URL || metaEnv.PUBLIC_BASE_URL || '').trim();
export const PUBLIC_BASE_URL = rawBaseUrl.endsWith('/') ? rawBaseUrl.slice(0, -1) : rawBaseUrl;

interface DesktopBridge {
  invoke(channel: string, args?: any): Promise<{ ok: boolean; data?: any; error?: string; code?: string }>;
}

declare global {
  interface Window {
    gateway?: DesktopBridge;
    gatewayUrl?: string;
  }
}

/** True inside the Electron desktop shell (preload exposes window.gateway). */
export function isDesktopBridge(): boolean {
  return typeof window !== 'undefined' && !!window.gateway;
}

/**
 * Absolute gateway base for direct /v1 fetch calls (Playground). Under the
 * desktop shell the renderer loads from file:// so relative URLs would break;
 * main injects an explicit http://127.0.0.1:PORT base via preload.
 */
let cachedGatewayUrl = '';
if (typeof window !== 'undefined' && (window as any).gateway) {
  // Belt-and-braces: even if the preload argv injection ever fails, resolve
  // the base once via IPC (Playground only needs it after user interaction).
  (window as any).gateway
    .invoke('gw:settings', {})
    .then((res: any) => {
      if (res?.ok && res.data?.gatewayUrl) cachedGatewayUrl = res.data.gatewayUrl;
    })
    .catch(() => undefined);
}

function getGatewayBase(): string {
  if (typeof window !== 'undefined' && window.gatewayUrl) return window.gatewayUrl;
  if (cachedGatewayUrl) return cachedGatewayUrl;
  return PUBLIC_BASE_URL;
}

export function getApiUrl(path: string): string {
  const base = getGatewayBase();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${cleanPath}` : cleanPath;
}

let inMemoryCsrfToken: string = '';

export function setCsrfToken(token: string) {
  inMemoryCsrfToken = token;
}

export function getCsrfToken(): string {
  return inMemoryCsrfToken;
}

export async function checkAdminSession(): Promise<{ authenticated: boolean; csrfToken?: string; expiresAt?: string }> {
  // Desktop shell is single-user local: always authenticated, no login needed.
  if (isDesktopBridge()) return { authenticated: true };
  try {
    const res = await fetch(getApiUrl('/api/admin/auth/session'), { credentials: 'include' });
    if (!res.ok) return { authenticated: false };
    const data = await res.json();
    if (data.authenticated && data.csrfToken) {
      setCsrfToken(data.csrfToken);
    }
    return data;
  } catch {
    return { authenticated: false };
  }
}

export async function loginAdmin(_credential: string): Promise<{ success: boolean; error?: string }> {
  if (isDesktopBridge()) return { success: true };
  try {
    const res = await fetch(getApiUrl('/api/admin/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ credential: _credential }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      if (data.csrfToken) {
        setCsrfToken(data.csrfToken);
      }
      return { success: true };
    }
    return { success: false, error: data.error || 'Invalid admin credentials' };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function logoutAdmin(): Promise<void> {
  if (isDesktopBridge()) return;
  try {
    await fetch(getApiUrl('/api/admin/auth/logout'), {
      method: 'POST',
      headers: inMemoryCsrfToken ? { 'x-csrf-token': inMemoryCsrfToken } : {},
      credentials: 'include',
    });
  } finally {
    setCsrfToken('');
  }
}

/**
 * Translate an admin REST call into a desktop IPC operation. Returns null
 * for non-admin URLs (direct /v1 fetch keeps using HTTP).
 */
function routeToDesktopOp(method: string, url: string, body: any): { op: string; args: any } | null {
  const [rawPath, rawQuery] = url.split('?');
  const seg = rawPath.split('/').filter(Boolean);
  // Expect ['api','admin',...]
  if (seg.length < 2 || seg[0] !== 'api' || seg[1] !== 'admin') return null;
  const rest = seg.slice(2);
  const query = new URLSearchParams(rawQuery || '');

  if (rest[0] === 'accounts') {
    if (rest.length === 1) {
      if (method === 'GET') return { op: 'accounts:list', args: {} };
      if (method === 'POST') return { op: 'accounts:create', args: body || {} };
    }
    if (rest.length === 2) {
      const id = decodeURIComponent(rest[1]);
      if (method === 'GET') return { op: 'accounts:get', args: { id } };
      if (method === 'PATCH') return { op: 'accounts:update', args: { id, updates: body || {} } };
      if (method === 'DELETE') return { op: 'accounts:delete', args: { id } };
    }
    if (rest.length === 3) {
      const id = decodeURIComponent(rest[1]);
      if (rest[2] === 'cookie' && method === 'POST') return { op: 'accounts:replace-cookie', args: { id, cookie: body?.cookie } };
      if (rest[2] === 'status' && method === 'PATCH') return { op: 'accounts:set-status', args: { id, status: body?.status, reason: body?.reason } };
      if (rest[2] === 'test' && method === 'POST') return { op: 'accounts:test-session', args: { id } };
      if (rest[2] === 'keepalive' && method === 'POST') return { op: 'keepalive:trigger', args: { id } };
      if (rest[2] === 'discover-models' && method === 'POST') return { op: 'accounts:discover-models', args: { id } };
      if (rest[2] === 'quota' && method === 'GET') return { op: 'accounts:quota', args: { id } };
    }
  }
  if (rest[0] === 'keepalive' && rest[1] === 'status' && method === 'GET') {
    return { op: 'keepalive:status', args: {} };
  }
  if (rest[0] === 'proxy' && rest[1] === 'test' && method === 'POST') {
    return { op: 'proxy:test', args: { proxy_url: body?.proxy_url } };
  }
  if (rest[0] === 'browser-onboard') {
    if (rest[1] === 'start' && method === 'POST') {
      return {
        op: 'login:start',
        args: {
          accountId: body?.accountId,
          mode: body?.mode === 'external' ? 'external' : 'window',
          name: body?.name,
          emailLabel: body?.emailLabel,
          proxyUrl: body?.proxyUrl,
          priority: body?.priority,
          weight: body?.weight,
        },
      };
    }
    if (rest[1] === 'status' && rest[2] && method === 'GET') {
      return { op: 'login:status', args: { sessionId: decodeURIComponent(rest[2]) } };
    }
    if (rest[1] === 'cancel' && rest[2] && method === 'POST') {
      return { op: 'login:cancel', args: { sessionId: decodeURIComponent(rest[2]) } };
    }
  }
  if (rest[0] === 'api-keys') {
    if (rest.length === 1) {
      if (method === 'GET') return { op: 'keys:list', args: {} };
      if (method === 'POST') return { op: 'keys:create', args: body || {} };
    }
    if (rest.length === 2) {
      const id = decodeURIComponent(rest[1]);
      if (method === 'GET') return { op: 'keys:get', args: { id } };
      if (method === 'PATCH') return { op: 'keys:update', args: { id, updates: body || {} } };
      if (method === 'DELETE') return { op: 'keys:delete', args: { id } };
    }
  }
  if (rest.length === 1 && method === 'GET') {
    if (rest[0] === 'analytics') return { op: 'analytics', args: {} };
    if (rest[0] === 'logs') return { op: 'logs', args: {} };
    if (rest[0] === 'events') return { op: 'events', args: {} };
    if (rest[0] === 'models') return { op: 'models', args: {} };
    if (rest[0] === 'settings') return { op: 'settings', args: {} };
  }
  if (rest[0] === 'conversations') {
    if (rest[1] === 'upstream-recent' && method === 'GET') {
      return { op: 'conversations:recent', args: { limit: query.get('limit') || '10', account_id: query.get('account_id') || undefined } };
    }
    if (rest[1] === 'upstream' && rest[2] && rest[3] === 'turns' && method === 'GET') {
      return { op: 'conversations:turns', args: { cid: decodeURIComponent(rest[2]), account_id: query.get('account_id') || undefined } };
    }
  }
  if (rest[0] === 'auth') {
    // Desktop: no login ceremony.
    if (rest[1] === 'session' && method === 'GET') return { op: '__auth_session', args: {} };
    if (rest[1] === 'login' && method === 'POST') return { op: '__auth_login', args: {} };
    if (rest[1] === 'logout' && method === 'POST') return { op: '__auth_logout', args: {} };
  }
  return null;
}

/** Wrap an IPC result in the legacy HTTP JSON envelope callers expect. */
function desktopEnvelope(op: string, data: any): any {
  switch (op) {
    case 'accounts:list': return { accounts: data.accounts || [] };
    case 'accounts:get': return { account: data.account };
    case 'accounts:create': return { account: data.account };
    case 'accounts:update': return { account: data.account };
    case 'logs': return { logs: data.logs || [] };
    case 'events': return { events: data.events || [] };
    case 'models': return { models: data.models || [] };
    case 'keys:list': return { keys: data.keys || [] };
    case 'keys:get': return { keyRecord: data.keyRecord };
    case 'keys:create': return { apiKey: data.apiKey, keyRecord: data.keyRecord };
    case 'keys:update': return { keyRecord: data.keyRecord };
    case 'login:start': return { session: data };
    case 'login:status': return { session: data };
    case 'login:cancel': return { success: data.success };
    case '__auth_session': return { authenticated: true };
    case '__auth_login': return { success: true };
    case '__auth_logout': return { success: true };
    default: return data;
  }
}

function desktopErrorStatus(code?: string, message?: string): number {
  if (code === 'NOT_FOUND') return 404;
  if (message && message.includes('NO_HEALTHY_ACCOUNTS')) return 503;
  if (message && message.includes('CONVERSATION_ACCOUNT_UNAVAILABLE')) return 503;
  return 400;
}

export async function adminFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();

  // Desktop shell: serve /api/admin/* from main-process services via IPC.
  if (isDesktopBridge() && typeof input === 'string' && input.startsWith('/api/admin')) {
    let body: any = undefined;
    try {
      body = init.body ? JSON.parse(init.body as string) : undefined;
    } catch {
      body = undefined;
    }
    const routed = routeToDesktopOp(method, input, body);
    if (!routed) {
      return new Response(JSON.stringify({ error: `Unsupported desktop operation: ${method} ${input}` }), { status: 404 });
    }
    const res = await window.gateway!.invoke(`gw:${routed.op}`, routed.args);
    if (res && res.ok) {
      return new Response(JSON.stringify(desktopEnvelope(routed.op, res.data)), { status: 200 });
    }
    const message = (res && res.error) || `Desktop operation failed: ${routed.op}`;
    return new Response(JSON.stringify({ error: message, success: false, message }), {
      status: desktopErrorStatus(res?.code, message),
    });
  }

  const target = typeof input === 'string' && input.startsWith('/') ? getApiUrl(input) : input;
  const headers = new Headers(init.headers || {});

  // Attach CSRF token for mutating requests
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && inMemoryCsrfToken && !headers.has('x-csrf-token')) {
    headers.set('x-csrf-token', inMemoryCsrfToken);
  }

  const response = await fetch(target, {
    ...init,
    credentials: 'include',
    headers,
  });

  return response;
}

// ==========================================
// TanStack Query Fetchers (Pure Server State)
// ==========================================

export async function fetchAccounts(): Promise<SafeAccount[]> {
  const res = await adminFetch('/api/admin/accounts');
  if (!res.ok) {
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    throw new Error(`Failed to load accounts: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.accounts || [];
}

export async function fetchAccount(id: string): Promise<SafeAccount> {
  const res = await adminFetch(`/api/admin/accounts/${id}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error('NOT_FOUND');
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    throw new Error(`Failed to load account: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.account;
}

export async function fetchAccountQuota(id: string): Promise<AccountQuotaInfo> {
  const res = await adminFetch(`/api/admin/accounts/${encodeURIComponent(id)}/quota`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to load account quota: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.quota;
}

export async function fetchApiKeys(): Promise<ApiKeyItem[]> {
  const res = await adminFetch('/api/admin/api-keys');
  if (!res.ok) {
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    throw new Error(`Failed to load API keys: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.keys || [];
}

export async function fetchApiKey(id: string): Promise<ApiKeyItem> {
  const res = await adminFetch(`/api/admin/api-keys/${id}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error('NOT_FOUND');
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    throw new Error(`Failed to load API key: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.keyRecord;
}

export async function fetchAnalytics(): Promise<AnalyticsData> {
  const res = await adminFetch('/api/admin/analytics');
  if (!res.ok) {
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    throw new Error(`Failed to load analytics: HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchLogs(): Promise<RequestLogItem[]> {
  const res = await adminFetch('/api/admin/logs');
  if (!res.ok) {
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    throw new Error(`Failed to load logs: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.logs || [];
}

export async function fetchEvents(): Promise<AccountEventItem[]> {
  const res = await adminFetch('/api/admin/events');
  if (!res.ok) {
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    throw new Error(`Failed to load events: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.events || [];
}

export async function fetchModels(): Promise<string[]> {
  const res = await adminFetch('/api/admin/models');
  if (!res.ok) {
    throw new Error(`Failed to load models: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.models || [];
}

export async function fetchSettings(): Promise<SystemSettings> {
  const res = await adminFetch('/api/admin/settings');
  if (!res.ok) {
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    throw new Error(`Failed to load settings: HTTP ${res.status}`);
  }
  return res.json();
}

export interface KeepAliveStatusReport {
  isWorkerRunning: boolean;
  isCurrentlyRefreshing: boolean;
  currentAccountId: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  totalRefreshedSuccess: number;
  totalRefreshedFailed: number;
  lastSummary: string | null;
}

export interface OnboardingSessionState {
  sessionId: string;
  accountId: string;
  isReLogin: boolean;
  mode?: 'window' | 'external';
  name: string;
  emailLabel: string;
  proxyUrl?: string | null;
  priority: number;
  weight: number;
  step: 'INITIALIZING' | 'WAITING_LOGIN' | 'EXTRACTING' | 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT' | 'ERROR';
  message: string;
  account?: SafeAccount;
  error?: string;
  createdAt: number;
  expiresAt: number;
}

export async function fetchKeepAliveStatus(): Promise<KeepAliveStatusReport> {
  const res = await adminFetch('/api/admin/keepalive/status');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function triggerKeepAlive(id: string): Promise<{ success: boolean; message: string }> {
  const res = await adminFetch(`/api/admin/accounts/${id}/keepalive`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

export async function testProxy(proxy_url: string): Promise<{ success: boolean; ip?: string; latencyMs?: number; error?: string }> {
  const res = await adminFetch('/api/admin/proxy/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxy_url }),
  });
  return res.json();
}

export async function updateAccount(id: string, updates: Partial<SafeAccount>): Promise<SafeAccount> {
  const res = await adminFetch(`/api/admin/accounts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.account;
}

export async function startBrowserOnboarding(data: {
  accountId?: string;
  /** 'external' = open the user's real Chrome; 'window' = embedded app window. */
  mode?: 'external' | 'window';
  name?: string;
  emailLabel?: string;
  proxyUrl?: string | null;
  priority?: number;
  weight?: number;
}): Promise<OnboardingSessionState> {
  const res = await adminFetch('/api/admin/browser-onboard/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const body = await res.json();
  return body.session;
}

export async function getBrowserOnboardingStatus(sessionId: string): Promise<OnboardingSessionState> {
  const res = await adminFetch(`/api/admin/browser-onboard/status/${sessionId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const body = await res.json();
  return body.session;
}

export async function cancelBrowserOnboarding(sessionId: string): Promise<boolean> {
  const res = await adminFetch(`/api/admin/browser-onboard/cancel/${sessionId}`, {
    method: 'POST',
  });
  const body = await res.json().catch(() => ({ success: false }));
  return Boolean(body.success);
}

/**
 * Desktop-only: user pressed "Đã đăng nhập xong" — finalize the login
 * window session immediately instead of waiting for auto-detect.
 */
export async function confirmBrowserLogin(sessionId: string): Promise<OnboardingSessionState> {
  if (!isDesktopBridge() || !window.gateway) {
    throw new Error('Xác nhận chỉ khả dụng trong app desktop');
  }
  const res = await window.gateway.invoke('gw:login:confirm', { sessionId });
  if (!res.ok) throw new Error(res.error || 'Xác nhận đăng nhập thất bại');
  return res.data;
}

export interface DesktopAppConfigState {
  shareLan: boolean;
  port: number;
  gatewayUrl: string;
  restartRequired: boolean;
}

export async function fetchDesktopAppConfig(): Promise<DesktopAppConfigState> {
  if (!isDesktopBridge() || !window.gateway) {
    throw new Error('Desktop config is only available in the desktop app');
  }
  const res = await window.gateway.invoke('gw:app-config:get', {});
  if (!res.ok) throw new Error(res.error || 'Failed to load desktop config');
  return res.data;
}

export async function updateDesktopAppConfig(patch: { shareLan?: boolean; port?: number }): Promise<DesktopAppConfigState> {
  if (!isDesktopBridge() || !window.gateway) {
    throw new Error('Desktop config is only available in the desktop app');
  }
  const res = await window.gateway.invoke('gw:app-config:set', patch);
  if (!res.ok) throw new Error(res.error || 'Failed to save desktop config');
  return res.data;
}

// ==========================================
// Mutations
// ==========================================

export async function createAccount(data: {
  name: string;
  email_label: string;
  cookie: string;
  auth_user?: string;
  priority?: number;
  weight?: number;
  supported_models?: string[];
  proxy_url?: string | null;
}): Promise<SafeAccount> {
  const res = await adminFetch('/api/admin/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const body = await res.json();
  return body.account;
}

export async function replaceAccountCookie(id: string, cookie: string): Promise<void> {
  const res = await adminFetch(`/api/admin/accounts/${id}/cookie`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

export async function toggleAccountStatus(id: string, nextStatus: AccountStatus, reason?: string): Promise<void> {
  const res = await adminFetch(`/api/admin/accounts/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: nextStatus, reason: reason || 'Updated via Admin UI' }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

export async function testAccountSession(id: string): Promise<{ valid: boolean; status?: string; error?: string }> {
  const res = await adminFetch(`/api/admin/accounts/${id}/test`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function deleteAccount(id: string): Promise<void> {
  const res = await adminFetch(`/api/admin/accounts/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

export async function createApiKey(data: {
  name: string;
  allowed_models?: string[];
  rpm_limit?: number;
  concurrent_limit?: number;
  daily_request_limit?: number;
  expires_in_days?: number;
}): Promise<{ apiKey: string; keyRecord: ApiKeyItem }> {
  const res = await adminFetch('/api/admin/api-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function updateApiKey(id: string, updates: Partial<ApiKeyItem>): Promise<ApiKeyItem> {
  const res = await adminFetch(`/api/admin/api-keys/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.keyRecord;
}

export async function deleteApiKey(id: string): Promise<void> {
  const res = await adminFetch(`/api/admin/api-keys/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

export interface UpstreamConversationItem {
  id: string; // c_...
  title: string;
  updated_at: string;
  account_id?: string;
  timestamp_seconds?: number;
  choice_id?: string;
}

export interface UpstreamTurnItem {
  role: 'user' | 'assistant';
  content: string;
  reasoning_content?: string;
  choice_id?: string;
  response_id?: string;
  timestamp?: number;
}

export async function fetchUpstreamRecentConversations(limit = 10): Promise<{
  account_id: string;
  account_name: string;
  conversations: UpstreamConversationItem[];
}> {
  const res = await adminFetch(`/api/admin/conversations/upstream-recent?limit=${limit}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchUpstreamConversationTurns(cid: string, accountId?: string): Promise<{
  conversation_id: string;
  account_id: string;
  turns: UpstreamTurnItem[];
  last_rid?: string;
  last_rcid?: string;
}> {
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  const res = await adminFetch(`/api/admin/conversations/upstream/${encodeURIComponent(cid)}/turns${query}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

