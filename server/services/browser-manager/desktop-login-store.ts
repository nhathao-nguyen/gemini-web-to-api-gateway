import crypto from 'crypto';
import { db } from '../../db/database.js';
import { accountManager } from '../account-manager.js';
import { validateGeminiCookie } from '../../utils/cookie.js';
import { geminiProvider } from '../gemini-adapter/index.js';
import type { GeminiAccount } from '../../types.js';

export type DesktopLoginStep =
  | 'INITIALIZING'
  | 'WAITING_LOGIN'
  | 'EXTRACTING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'ERROR';

export type DesktopLoginMode = 'window' | 'external';

export interface DesktopLoginSession {
  sessionId: string;
  /** One-time token the companion extension uses to deliver cookies. */
  captureToken: string;
  accountId: string;
  isReLogin: boolean;
  mode: DesktopLoginMode;
  name: string;
  emailLabel: string;
  proxyUrl?: string | null;
  priority: number;
  weight: number;
  step: DesktopLoginStep;
  message: string;
  account?: Omit<GeminiAccount, 'encrypted_cookie'>;
  error?: string;
  createdAt: number;
  expiresAt: number;
}

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const sessions = new Map<string, DesktopLoginSession>();
const tokenToSession = new Map<string, string>();

export function pruneExpiredLogins(): void {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now > s.expiresAt + 30 * 60 * 1000) {
      sessions.delete(id);
      tokenToSession.delete(s.captureToken);
    }
  }
}

export function createPendingLogin(options: {
  accountId?: string;
  mode?: DesktopLoginMode;
  name?: string;
  emailLabel?: string;
  proxyUrl?: string | null;
  priority?: number;
  weight?: number;
}): DesktopLoginSession {
  const isReLogin = Boolean(options.accountId);
  let existing: GeminiAccount | undefined;
  if (isReLogin && options.accountId) {
    existing = db.getAccountById(options.accountId);
    if (!existing) throw new Error(`NOT_FOUND: Account ${options.accountId} not found`);
  }

  const accountId = options.accountId || `acc_${crypto.randomBytes(8).toString('hex')}`;
  const now = Date.now();
  const session: DesktopLoginSession = {
    sessionId: `login_${crypto.randomBytes(8).toString('hex')}`,
    captureToken: `cap_${crypto.randomBytes(32).toString('hex')}`,
    accountId,
    isReLogin,
    mode: options.mode || 'window',
    name: options.name || existing?.name || `Gemini Account (${new Date().toLocaleDateString()})`,
    emailLabel: options.emailLabel || existing?.email_label || '',
    proxyUrl: options.proxyUrl !== undefined ? options.proxyUrl : existing?.proxy_url || null,
    priority: options.priority ?? existing?.priority ?? 10,
    weight: options.weight ?? existing?.weight ?? 1,
    step: 'INITIALIZING',
    message: 'Đang chờ đăng nhập Google...',
    createdAt: now,
    expiresAt: now + LOGIN_TIMEOUT_MS,
  };
  pruneExpiredLogins();
  sessions.set(session.sessionId, session);
  tokenToSession.set(session.captureToken, session.sessionId);
  return { ...session };
}

export function getLoginSession(sessionId: string): DesktopLoginSession | undefined {
  const s = sessions.get(sessionId);
  if (!s) return undefined;
  if (Date.now() > s.expiresAt && (s.step === 'INITIALIZING' || s.step === 'WAITING_LOGIN')) {
    s.step = 'TIMED_OUT';
    s.message = 'Hết thời gian đăng nhập (5 phút). Vui lòng thử lại.';
  }
  return { ...s };
}

/** Resolve a one-time capture token to its session. Tokens are single-use. */
export function consumeCaptureToken(token: string): DesktopLoginSession | undefined {
  const sessionId = tokenToSession.get(token);
  if (!sessionId) return undefined;
  tokenToSession.delete(token);
  const s = sessions.get(sessionId);
  return s ? { ...s } : undefined;
}

/**
 * (Re)arm the capture token for a pending session — used when the extension
 * asks for a delivery token. Terminal sessions get nothing.
 */
export function refreshCaptureToken(sessionId: string): string | undefined {
  const s = sessions.get(sessionId);
  if (!s || s.step === 'COMPLETED' || s.step === 'CANCELLED' || s.step === 'TIMED_OUT') return undefined;
  if (Date.now() > s.expiresAt) return undefined;
  tokenToSession.set(s.captureToken, sessionId);
  return s.captureToken;
}

export function setLoginSessionState(
  sessionId: string,
  patch: Partial<Pick<DesktopLoginSession, 'step' | 'message' | 'error' | 'account'>>
): DesktopLoginSession | undefined {
  const s = sessions.get(sessionId);
  if (!s) return undefined;
  Object.assign(s, patch);
  return { ...s };
}

export function cancelLoginSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  if (s.step !== 'COMPLETED') {
    s.step = 'CANCELLED';
    s.message = 'Đã hủy đăng nhập.';
  }
  tokenToSession.delete(s.captureToken);
  return true;
}

/** Sessions still waiting for cookies — shown in the companion extension popup. */
export function listPendingLogins(): Array<{
  sessionId: string;
  name: string;
  emailLabel: string;
  isReLogin: boolean;
  mode: DesktopLoginMode;
  expiresAt: number;
}> {
  pruneExpiredLogins();
  const now = Date.now();
  const out = [];
  for (const s of sessions.values()) {
    if ((s.step === 'INITIALIZING' || s.step === 'WAITING_LOGIN' || s.step === 'EXTRACTING') && now <= s.expiresAt) {
      out.push({
        sessionId: s.sessionId,
        name: s.name,
        emailLabel: s.emailLabel,
        isReLogin: s.isReLogin,
        mode: s.mode,
        expiresAt: s.expiresAt,
      });
    }
  }
  return out;
}

/**
 * Complete a login with a raw cookie header (from the companion extension or
 * the embedded window). Validates, encrypts (inside accountManager), creates
 * or replaces the account, and marks the session COMPLETED.
 */
export function completeLoginWithCookie(sessionId: string, cookieHeader: string): DesktopLoginSession {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('NOT_FOUND: Login session not found or expired');
  if (s.step === 'COMPLETED') return { ...s };
  if (Date.now() > s.expiresAt) {
    s.step = 'TIMED_OUT';
    s.message = 'Hết thời gian đăng nhập (5 phút). Vui lòng thử lại.';
    throw new Error('Login session expired. Please start a new login.');
  }

  s.step = 'EXTRACTING';
  s.message = 'Đã nhận session. Đang lưu vào bể quota...';

  const check = validateGeminiCookie(cookieHeader);
  if (!check.valid) {
    s.step = 'ERROR';
    s.message = 'Cookie chưa đủ (thiếu phiên Google). Hãy đăng nhập Google xong rồi gửi lại.';
    s.error = 'Invalid cookie';
    throw new Error('Cookie chưa đủ. Hãy đăng nhập Google trong Chrome xong rồi gửi lại.');
  }

  if (s.isReLogin) {
    const okReplace = accountManager.replaceCookie(s.accountId, check.normalized);
    if (!okReplace) {
      s.step = 'ERROR';
      s.message = `Không tìm thấy account ${s.accountId} để relogin.`;
      throw new Error(s.message);
    }
    geminiProvider.invalidateSession(s.accountId);
    const acc = db.getAccountById(s.accountId);
    if (acc) {
      const { encrypted_cookie, ...safe } = acc;
      s.account = safe;
    }
  } else {
    const created = accountManager.createAccount({
      name: s.name,
      email_label: s.emailLabel || `${s.accountId}@google.com`,
      cookie: check.normalized,
      auth_user: '0',
      priority: s.priority,
      weight: s.weight,
    });
    const full = db.getAccountById(created.id);
    // New accounts get the generated id; point the session at it.
    s.accountId = created.id;
    if (full) {
      const { encrypted_cookie, ...safe } = full;
      s.account = safe;
    } else {
      s.account = created as any;
    }
  }

  s.step = 'COMPLETED';
  s.message = 'Đăng nhập thành công. Account đã vào bể quota.';
  tokenToSession.delete(s.captureToken);
  return { ...s };
}
