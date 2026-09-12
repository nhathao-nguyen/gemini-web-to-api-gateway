import crypto from 'crypto';
import type { BrowserContext } from 'playwright';
import {
  launchStealthContext,
  getProfileDir,
  DEFAULT_USER_AGENT,
  acquireProfileLock,
  releaseProfileLock,
} from './stealth-factory.js';
import { db } from '../../db/database.js';
import { encryptCookie } from '../../utils/crypto.js';
import { normalizeCookieString, validateGeminiCookie } from '../../utils/cookie.js';
import { config } from '../../config.js';
import { GeminiAccount } from '../../types.js';
import { geminiProvider } from '../gemini-adapter/index.js';

export type OnboardingStep =
  | 'INITIALIZING'
  | 'WAITING_LOGIN'
  | 'EXTRACTING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'ERROR';

export interface OnboardingSession {
  sessionId: string;
  accountId: string;
  isReLogin: boolean;
  name: string;
  emailLabel: string;
  proxyUrl?: string | null;
  priority: number;
  weight: number;
  step: OnboardingStep;
  message: string;
  account?: Omit<GeminiAccount, 'encrypted_cookie'>;
  error?: string;
  createdAt: number;
  expiresAt: number;
}

class BrowserOnboardingService {
  private sessions = new Map<string, OnboardingSession>();
  private activeContexts = new Map<string, BrowserContext>();
  private pollTimers = new Map<string, NodeJS.Timeout>();

  public getSession(sessionId: string): OnboardingSession | undefined {
    return this.sessions.get(sessionId);
  }

  public async startSession(options: {
    accountId?: string;
    name?: string;
    emailLabel?: string;
    proxyUrl?: string | null;
    priority?: number;
    weight?: number;
  }): Promise<OnboardingSession> {
    const isReLogin = Boolean(options.accountId);
    let existingAccount: GeminiAccount | undefined;

    if (isReLogin && options.accountId) {
      existingAccount = db.getAccountById(options.accountId);
      if (!existingAccount) {
        throw new Error(`Account with ID "${options.accountId}" not found`);
      }
    }

    const accountId = options.accountId || `acc_${crypto.randomBytes(8).toString('hex')}`;
    const sessionId = `onboard_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();
    const timeoutMs = 5 * 60 * 1000; // 5 minutes

    const session: OnboardingSession = {
      sessionId,
      accountId,
      isReLogin,
      name: options.name || existingAccount?.name || `Gemini Account (${new Date().toLocaleDateString()})`,
      emailLabel: options.emailLabel || existingAccount?.email_label || '',
      proxyUrl: options.proxyUrl !== undefined ? options.proxyUrl : (existingAccount?.proxy_url || null),
      priority: options.priority ?? existingAccount?.priority ?? 10,
      weight: options.weight ?? existingAccount?.weight ?? 1,
      step: 'INITIALIZING',
      message: 'Đang khởi động trình duyệt Chromium Stealth...',
      createdAt: now,
      expiresAt: now + timeoutMs,
    };

    // Prune stale sessions older than 30 minutes to prevent memory leak
    for (const [sId, s] of this.sessions.entries()) {
      if (now > s.expiresAt + 30 * 60 * 1000) {
        this.sessions.delete(sId);
      }
    }

    this.sessions.set(sessionId, session);

    // Launch browser asynchronously
    this.initiateBrowser(session).catch((err) => {
      console.error(`[Onboarding] Error initiating browser for ${sessionId}:`, err);
      session.step = 'ERROR';
      session.message = `Khởi chạy trình duyệt thất bại: ${err.message}`;
      session.error = err.message;
    });

    return session;
  }

  private async initiateBrowser(session: OnboardingSession) {
    try {
      if (!acquireProfileLock(session.accountId)) {
        session.step = 'ERROR';
        session.message = `Thư mục Profile của tài khoản "${session.accountId}" đang được sử dụng bởi một tiến trình khác (ví dụ: KeepAlive). Vui lòng thử lại sau giây lát.`;
        session.error = 'Profile currently locked by another process';
        return;
      }

      console.log(`[Onboarding] Launching headed browser for account ${session.accountId} (Session: ${session.sessionId})`);

      const context = await launchStealthContext({
        accountId: session.accountId,
        headless: false, // Headed mode for human login
        proxyUrl: session.proxyUrl,
        userAgent: DEFAULT_USER_AGENT,
      });

      this.activeContexts.set(session.sessionId, context);

      // Handle user manually closing browser window
      context.on('close', async () => {
        const timer = this.pollTimers.get(session.sessionId);
        if (timer) {
          clearInterval(timer);
          this.pollTimers.delete(session.sessionId);
        }
        if (session.step !== 'COMPLETED' && session.step !== 'TIMED_OUT') {
          session.step = 'CANCELLED';
          session.message = 'Cửa sổ trình duyệt đã bị đóng trước khi hoàn tất đăng nhập.';
        }
        await this.cleanupSession(session.sessionId);
      });

      const page = context.pages()[0] || (await context.newPage());
      try {
        await page.bringToFront();
      } catch {}

      session.step = 'WAITING_LOGIN';
      session.message = 'Cửa sổ trình duyệt đã mở! Vui lòng đăng nhập tài khoản Google và vượt qua xác thực 2FA...';

      // Navigate to Gemini Web
      await page.goto('https://gemini.google.com/app', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      try {
        await page.bringToFront();
      } catch {}

      // Start watcher loop
      this.watchLoginProgress(session, context, page);
    } catch (err: any) {
      session.step = 'ERROR';
      session.message = `Lỗi khởi động cửa sổ: ${err.message}`;
      session.error = err.message;
      await this.cleanupSession(session.sessionId);
    }
  }

  private watchLoginProgress(
    session: OnboardingSession,
    context: BrowserContext,
    page: any
  ) {
    const checkInterval = 2000;

    const timer = setInterval(async () => {
      // Check timeout
      if (Date.now() > session.expiresAt) {
        clearInterval(timer);
        this.pollTimers.delete(session.sessionId);
        session.step = 'TIMED_OUT';
        session.message = 'Hết thời gian chờ đăng nhập (5 phút). Phiên đã bị hủy.';
        await this.cleanupSession(session.sessionId);
        return;
      }

      // Check if context closed by user closing window
      if (!context.pages() || context.pages().length === 0) {
        clearInterval(timer);
        this.pollTimers.delete(session.sessionId);
        if (session.step !== 'COMPLETED') {
          session.step = 'CANCELLED';
          session.message = 'Cửa sổ trình duyệt đã bị đóng trước khi hoàn tất đăng nhập.';
        }
        await this.cleanupSession(session.sessionId);
        return;
      }

      try {
        const currentUrl = page.url();
        const targetedCookies = await context.cookies(['https://gemini.google.com', 'https://google.com']);

        // Check essential Google authentication tokens
        const psidCookie = targetedCookies.find((c) => c.name === '__Secure-1PSID' || c.name === 'SID');
        const tsCookie = targetedCookies.find((c) => c.name === '__Secure-1PSIDTS');

        // Check if user reached Gemini main app with valid authentication cookie
        const isAppUrl = currentUrl.includes('gemini.google.com') && !currentUrl.includes('accounts.google.com');

        // Check DOM: make sure page has authenticated state and is not showing a Sign-In button
        let isDomAuth = false;
        try {
          isDomAuth = await page.evaluate(() => {
            const hasSignIn = !!document.querySelector('a[href*="ServiceLogin"], [data-test-id="sign-in-button"]');
            const hasUserMenu = !!document.querySelector('a[href*="SignOutOptions"], a[aria-label*="@"], button[aria-label*="@"]');
            const hasChatPrompt = !!document.querySelector('rich-textarea, [contenteditable="true"], textarea');
            return !hasSignIn && (hasUserMenu || hasChatPrompt);
          });
        } catch {}

        const isFullyAuthenticated = (psidCookie && tsCookie && isAppUrl) || (psidCookie && isAppUrl && isDomAuth);

        if (isFullyAuthenticated) {
          console.log(`[Onboarding] Detected active Gemini session for ${session.accountId}! Waiting 3s for session settlement...`);
          session.step = 'EXTRACTING';
          session.message = 'Phát hiện đăng nhập thành công! Đang lưu trữ và mã hóa phiên đăng nhập...';

          clearInterval(timer);
          this.pollTimers.delete(session.sessionId);

          // Wait 3 seconds to let Google finish setting all tokens
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Re-fetch targeted cookies to capture fresh tokens
          const settledCookies = await context.cookies(['https://gemini.google.com', 'https://google.com']);
          // Filter strictly to .google.com and gemini.google.com domains (exclude foreign/third-party domains)
          const validCookies = settledCookies.filter(
            (c) => c.domain === '.google.com' || c.domain === 'gemini.google.com' || c.domain === '.gemini.google.com'
          );

          // Deduplicate by name, preferring gemini.google.com over .google.com
          const cookieMap = new Map<string, string>();
          for (const c of validCookies) {
            if (!cookieMap.has(c.name) || c.domain.includes('gemini')) {
              cookieMap.set(c.name, c.value);
            }
          }
          const cookieHeader = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
          const normalized = normalizeCookieString(cookieHeader);

          // Detect auth_user slot dynamically from URL (e.g. /u/1/)
          const finalUrl = page.url();
          const authUserMatch = finalUrl.match(/gemini\.google\.com\/u\/(\d+)\//);
          const detectedAuthUser = authUserMatch ? authUserMatch[1] : '0';

          // Attempt to extract user email or display name if available
          let detectedEmail = session.emailLabel;
          try {
            const accountBtnText = await page.evaluate(() => {
              // Try to find Google Account button text or aria-label
              const btn = document.querySelector('a[aria-label*="@"], button[aria-label*="@"], a[href*="SignOutOptions"]');
              return btn ? btn.getAttribute('aria-label') : null;
            });

            if (accountBtnText) {
              const match = accountBtnText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
              if (match) {
                detectedEmail = match[0];
              }
            }
          } catch {}

          if (!detectedEmail) {
            detectedEmail = `gemini-user-${session.accountId.slice(4, 10)}@google.com`;
          }

          // Encrypt and persist
          const encryptedCookie = encryptCookie(normalized, config.masterEncryptionKey);
          const nowStr = new Date().toISOString();
          const profileDir = getProfileDir(session.accountId);

          let savedAccount: GeminiAccount;

          if (session.isReLogin) {
            const existing = db.getAccountById(session.accountId);
            db.updateAccount(session.accountId, {
              encrypted_cookie: encryptedCookie,
              auth_user: detectedAuthUser,
              status: 'ACTIVE',
              email_label: detectedEmail || existing?.email_label || '',
              proxy_url: session.proxyUrl,
              profile_dir: profileDir,
              user_agent: DEFAULT_USER_AGENT,
              last_keepalive_at: nowStr,
              keepalive_status: 'SUCCESS',
              consecutive_errors: 0,
              last_error: null,
              cooldown_until: null,
            });

            savedAccount = db.getAccountById(session.accountId)!;
            db.addAccountEvent({
              id: `evt_${crypto.randomBytes(8).toString('hex')}`,
              account_id: session.accountId,
              event_type: 'BROWSER_RELOGIN_SUCCESS',
              from_status: existing?.status || null,
              to_status: 'ACTIVE',
              reason: 'Re-authenticated via Headed Chromium Browser',
              created_at: nowStr,
            });
          } else {
            savedAccount = {
              id: session.accountId,
              name: session.name,
              email_label: detectedEmail,
              encrypted_cookie: encryptedCookie,
              auth_user: detectedAuthUser,
              status: 'ACTIVE',
              priority: session.priority,
              weight: session.weight,
              supported_models: [],
              proxy_url: session.proxyUrl,
              profile_dir: profileDir,
              user_agent: DEFAULT_USER_AGENT,

              locale: 'en-US',
              timezone: 'America/New_York',
              last_keepalive_at: nowStr,
              keepalive_status: 'SUCCESS',
              last_success_at: nowStr,
              last_error_at: null,
              last_error: null,
              cooldown_until: null,
              consecutive_errors: 0,
              request_count: 0,
              created_at: nowStr,
              updated_at: nowStr,
            };

            db.createAccount(savedAccount);
            db.addAccountEvent({
              id: `evt_${crypto.randomBytes(8).toString('hex')}`,
              account_id: session.accountId,
              event_type: 'BROWSER_ONBOARD_SUCCESS',
              from_status: null,
              to_status: 'ACTIVE',
              reason: 'Registered via One-Time Headed Chromium Onboarding',
              created_at: nowStr,
            });
          }

          geminiProvider.invalidateSession(session.accountId);

          const { encrypted_cookie, ...safeAccount } = savedAccount;
          session.account = safeAccount;
          session.step = 'COMPLETED';
          session.message = `Đăng nhập thành công (${detectedEmail})! Phiên đã được mã hóa AES-256-GCM và kích hoạt trong pool.`;

          console.log(`[Onboarding] Onboarding completed for ${session.accountId}. Closing browser...`);
          await this.cleanupSession(session.sessionId);
        }
      } catch (err: any) {
        if (
          err.message &&
          (err.message.includes('Target page, context or browser has been closed') ||
            err.message.includes('TargetClosedError'))
        ) {
          clearInterval(timer);
          this.pollTimers.delete(session.sessionId);
          if (session.step !== 'COMPLETED') {
            session.step = 'CANCELLED';
            session.message = 'Cửa sổ trình duyệt đã bị đóng trước khi hoàn tất đăng nhập.';
          }
          await this.cleanupSession(session.sessionId);
        }
      }
    }, checkInterval);

    this.pollTimers.set(session.sessionId, timer);
  }

  public async cancelSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.step = 'CANCELLED';
    session.message = 'Phiên đăng nhập đã được hủy bởi quản trị viên.';

    const timer = this.pollTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(sessionId);
    }

    await this.cleanupSession(sessionId);
    return true;
  }

  private async cleanupSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session?.accountId) {
      releaseProfileLock(session.accountId);
    }
    const context = this.activeContexts.get(sessionId);
    if (context) {
      this.activeContexts.delete(sessionId);
      try {
        await context.close();
      } catch (err) {
        console.warn(`[Onboarding] Error closing browser context for ${sessionId}:`, err);
      }
    }
  }
}

export const browserOnboardingService = new BrowserOnboardingService();
