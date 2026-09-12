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

export function getApiUrl(path: string): string {
  if (!PUBLIC_BASE_URL) return path;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${PUBLIC_BASE_URL}${cleanPath}`;
}

let inMemoryCsrfToken: string = '';

export function setCsrfToken(token: string) {
  inMemoryCsrfToken = token;
}

export function getCsrfToken(): string {
  return inMemoryCsrfToken;
}

export async function checkAdminSession(): Promise<{ authenticated: boolean; csrfToken?: string; expiresAt?: string }> {
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

export async function loginAdmin(credential: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(getApiUrl('/api/admin/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ credential }),
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

export async function adminFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const target = typeof input === 'string' && input.startsWith('/') ? getApiUrl(input) : input;
  const headers = new Headers(init.headers || {});
  const method = (init.method || 'GET').toUpperCase();

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

