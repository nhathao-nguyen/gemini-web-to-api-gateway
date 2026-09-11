/**
 * Secure Session-based Admin API Client
 * - Uses HttpOnly cookies for session auth (credentials: 'include')
 * - Stores CSRF token strictly in-memory (no localStorage persistence)
 * - Removes any legacy credentials from client storage
 */

// Cleanup any legacy localStorage keys
try {
  localStorage.removeItem('gmgw_admin_key');
  localStorage.removeItem('admin_password');
} catch {}

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

export async function checkAdminSession(): Promise<{ authenticated: boolean; csrfToken?: string }> {
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
    return { success: false, error: data.error || 'Invalid credentials' };
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

  return fetch(target, {
    ...init,
    credentials: 'include',
    headers,
  });
}
