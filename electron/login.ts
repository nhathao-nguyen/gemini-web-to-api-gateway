import { BrowserWindow, session } from 'electron';
import { normalizeCookieString, validateGeminiCookie } from '../server/utils/cookie.js';
import { parseProxy } from '../server/services/browser-manager/stealth-factory.js';
import {
  createPendingLogin,
  getLoginSession,
  setLoginSessionState,
  cancelLoginSession,
  completeLoginWithCookie,
  type DesktopLoginSession,
} from '../server/services/browser-manager/desktop-login-store.js';
import { openUrlInUserChrome } from './chrome-launcher.js';

export type { DesktopLoginSession };

interface LiveLogin {
  sessionId: string;
  partition: string | null;
  win: BrowserWindow | null;
  timer: NodeJS.Timeout | null;
  finished: boolean;
}

const live = new Map<string, LiveLogin>();
const POLL_MS = 2000;

export interface LoginEvents {
  onUpdate?: (session: DesktopLoginSession) => void;
}

let events: LoginEvents = {};

export function setLoginEvents(e: LoginEvents): void {
  events = e;
}

function emit(sessionId: string): void {
  try {
    const s = getLoginSession(sessionId);
    if (s) events.onUpdate?.(s);
  } catch {
    // Listener errors must never break the login flow.
  }
}

function stopPolling(entry: LiveLogin): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function closeWindow(entry: LiveLogin): void {
  stopPolling(entry);
  try {
    if (entry.win && !entry.win.isDestroyed()) entry.win.close();
  } catch {
    // Best-effort cleanup.
  }
  entry.win = null;
}

function partitionFor(accountId: string): string {
  const sanitized = accountId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `persist:gemini-${sanitized}`;
}

/** Read Google auth cookies from the embedded login window's own session. */
async function readWindowCookie(partition: string): Promise<string> {
  const ses = session.fromPartition(partition);
  const cookies = await ses.cookies.get({});
  const relevant = cookies.filter(
    (c) => c.domain.includes('google.com') || c.domain.includes('gemini.google.com')
  );
  const header = relevant.map((c) => `${c.name}=${c.value}`).join('; ');
  return normalizeCookieString(header);
}

async function pollLogin(sessionId: string): Promise<void> {
  const entry = live.get(sessionId);
  if (!entry || entry.finished || !entry.partition) return;
  const current = getLoginSession(sessionId);
  if (!current || current.step === 'COMPLETED' || current.step === 'CANCELLED' || current.step === 'TIMED_OUT' || current.step === 'ERROR') {
    entry.finished = true;
    stopPolling(entry);
    return;
  }

  try {
    let url = '';
    try {
      if (entry.win && !entry.win.isDestroyed()) url = entry.win.webContents.getURL();
    } catch {
      // Window gone — keep waiting for explicit cancel/timeout.
    }
    const onLoginPage = url.includes('accounts.google.com');

    const header = await readWindowCookie(entry.partition);
    const check = validateGeminiCookie(header);
    const hasSession = header.includes('__Secure-1PSID=');

    if (hasSession && check.valid && !onLoginPage) {
      try {
        completeLoginWithCookie(sessionId, header);
      } catch {
        // Transient mismatch — stay in WAITING_LOGIN unless terminal.
        const after = getLoginSession(sessionId);
        if (!after || after.step === 'TIMED_OUT' || after.step === 'ERROR') {
          entry.finished = true;
          stopPolling(entry);
          emit(sessionId);
          return;
        }
      }
      emit(sessionId);
      entry.finished = true;
      stopPolling(entry);
      setTimeout(() => closeWindow(entry), 1500);
      return;
    }
    if (current.step === 'INITIALIZING') {
      setLoginSessionState(sessionId, {
        step: 'WAITING_LOGIN',
        message: 'Vui lòng đăng nhập tài khoản Google trong cửa sổ vừa mở.',
      });
      emit(sessionId);
    }
  } catch {
    // Transient read errors (window navigating) are normal — keep polling.
  }

  // Recursive setTimeout (never setInterval): iterations cannot overlap.
  entry.timer = setTimeout(() => void pollLogin(sessionId), POLL_MS);
}

export async function startDesktopLogin(options: {
  accountId?: string;
  mode?: 'window' | 'external';
  name?: string;
  emailLabel?: string;
  proxyUrl?: string | null;
  priority?: number;
  weight?: number;
}): Promise<DesktopLoginSession> {
  const mode = options.mode || 'window';
  const created = createPendingLogin({ ...options, mode });
  const entry: LiveLogin = {
    sessionId: created.sessionId,
    partition: mode === 'window' ? partitionFor(created.accountId) : null,
    win: null,
    timer: null,
    finished: false,
  };
  live.set(created.sessionId, entry);

  if (mode === 'external') {
    // Open the URL in the user's real Chrome: if Chrome is already running,
    // this opens a new window/tab in that instance (same profile + sessions).
    // Cookies come back via the companion extension + one-time capture token.
    try {
      await openUrlInUserChrome('https://gemini.google.com/app');
      setLoginSessionState(created.sessionId, {
        step: 'WAITING_LOGIN',
        message:
          'Chrome đã mở trang Gemini. Đăng nhập Google trong đó (nếu chưa), TẮT HẲN Chrome, rồi quay lại app bấm “Đã Đăng Nhập Xong — Xác Nhận”. (Không muốn tắt Chrome? Dùng extension “Gemini Gateway” → “Gửi session về app”.)',
      });
    } catch (err: any) {
      setLoginSessionState(created.sessionId, {
        step: 'ERROR',
        message: `Không mở được Chrome: ${err?.message || err}`,
        error: String(err?.message || err),
      });
      entry.finished = true;
    }
    emit(created.sessionId);
    const s = getLoginSession(created.sessionId);
    if (!s) throw new Error('Login session lost');
    return s;
  }

  // Embedded window flow.
  const partition = entry.partition as string;
  try {
    const ses = session.fromPartition(partition);
    const proxy = parseProxy(created.proxyUrl);
    if (proxy) {
      const hostPort = proxy.server.replace(/^[a-z0-9+.-]+:\/\//i, '');
      const scheme = proxy.server.startsWith('socks') ? 'socks' : 'http';
      await ses
        .setProxy({ proxyRules: `${scheme}=${hostPort};https=${hostPort}`, proxyBypassRules: '<local>' })
        .catch(() => undefined);
    }

    const win = new BrowserWindow({
      width: 1024,
      height: 760,
      show: true,
      title: created.isReLogin ? 'Đăng nhập lại Google — Gemini Gateway' : 'Đăng nhập Google — Gemini Gateway',
      webPreferences: { partition, sandbox: true },
    });
    entry.win = win;
    win.on('closed', () => {
      entry.win = null;
      if (!entry.finished) {
        entry.finished = true;
        cancelLoginSession(created.sessionId);
        stopPolling(entry);
        emit(created.sessionId);
      }
    });

    await win.loadURL('https://gemini.google.com/app');
    setLoginSessionState(created.sessionId, {
      step: 'WAITING_LOGIN',
      message: 'Vui lòng đăng nhập tài khoản Google trong cửa sổ vừa mở.',
    });
    emit(created.sessionId);
    entry.timer = setTimeout(() => void pollLogin(created.sessionId), POLL_MS);
  } catch (err: any) {
    entry.finished = true;
    setLoginSessionState(created.sessionId, {
      step: 'ERROR',
      message: `Không mở được cửa sổ đăng nhập: ${err?.message || err}`,
      error: String(err?.message || err),
    });
    emit(created.sessionId);
  }

  const s = getLoginSession(created.sessionId);
  if (!s) throw new Error('Login session lost');
  return s;
}

export function getDesktopLoginSession(sessionId: string): DesktopLoginSession | undefined {
  return getLoginSession(sessionId);
}

/** User pressed "Đã đăng nhập xong" — finalize immediately. */
export async function confirmDesktopLogin(sessionId: string): Promise<DesktopLoginSession> {
  const entry = live.get(sessionId);
  const current = getLoginSession(sessionId);
  if (!current) throw new Error('NOT_FOUND: Login session not found or expired');
  if (current.step === 'COMPLETED') return current;

  // External (real Chrome) flow: snapshot the user's Chrome profile and read
  // its Google cookies through a throwaway headless copy — no extension,
  // no interference with the running Chrome instance.
  if (!entry || !entry.partition) {
    setLoginSessionState(sessionId, {
      step: 'EXTRACTING',
      message: 'Đang đọc session Google từ Chrome của bạn...',
    });
    emit(sessionId);
    try {
      const { captureGoogleCookiesFromUserChrome } = await import(
        '../server/services/browser-manager/profile-snapshot.js'
      );
      const { cookieHeader } = await captureGoogleCookiesFromUserChrome();
      const done = completeLoginWithCookie(sessionId, cookieHeader);
      emit(sessionId);
      if (entry) {
        entry.finished = true;
        stopPolling(entry);
      }
      return done;
    } catch (err: any) {
      emit(sessionId);
      throw err;
    }
  }

  const header = await readWindowCookie(entry.partition);
  try {
    const done = completeLoginWithCookie(sessionId, header);
    emit(sessionId);
    entry.finished = true;
    stopPolling(entry);
    setTimeout(() => closeWindow(entry), 1500);
    return done;
  } catch (err: any) {
    emit(sessionId);
    throw err;
  }
}

export async function cancelDesktopLogin(sessionId: string): Promise<boolean> {
  const entry = live.get(sessionId);
  const ok = cancelLoginSession(sessionId);
  if (entry) {
    entry.finished = true;
    closeWindow(entry);
  }
  emit(sessionId);
  return ok;
}

export function closeAllLoginWindows(): void {
  for (const entry of live.values()) {
    try {
      closeWindow(entry);
    } catch {
      // Best-effort.
    }
  }
}
