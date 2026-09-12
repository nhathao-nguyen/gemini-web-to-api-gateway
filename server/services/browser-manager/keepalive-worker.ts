import crypto from 'crypto';
import { db } from '../../db/database.js';
import { GeminiAccount } from '../../types.js';
import {
  launchStealthContext,
  DEFAULT_USER_AGENT,
  acquireProfileLock,
  releaseProfileLock,
} from './stealth-factory.js';
import { normalizeCookieString } from '../../utils/cookie.js';
import { encryptCookie, decryptCookie } from '../../utils/crypto.js';
import { config } from '../../config.js';
import { geminiAccountUrl } from '../gemini-adapter/gemini-web.js';
import { geminiProvider } from '../gemini-adapter/index.js';

export interface KeepAliveReport {
  isWorkerRunning: boolean;
  isCurrentlyRefreshing: boolean;
  currentAccountId: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  totalRefreshedSuccess: number;
  totalRefreshedFailed: number;
  lastSummary: string | null;
}

export class KeepAliveWorker {
  private isRunning: boolean = false;
  private isProcessing: boolean = false;
  private currentAccountId: string | null = null;
  private loopTimer: NodeJS.Timeout | null = null;

  // Telemetry
  private lastRunAt: string | null = null;
  private nextRunAt: string | null = null;
  private totalRefreshedSuccess: number = 0;
  private totalRefreshedFailed: number = 0;
  private lastSummary: string | null = null;

  // Schedule intervals: check every 15 minutes, accounts eligible if last_keepalive > 4 hours ago
  private checkIntervalMs = 15 * 60 * 1000;
  private maxAgeMs = 4 * 60 * 60 * 1000;

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[KeepAliveWorker] Started headless browser session pool worker (Sequential Queue).');

    // Run first evaluation after 30 seconds startup grace period
    this.scheduleNext(30 * 1000);
  }

  public stop() {
    this.isRunning = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    console.log('[KeepAliveWorker] Stopped.');
  }

  public getStatus(): KeepAliveReport {
    return {
      isWorkerRunning: this.isRunning,
      isCurrentlyRefreshing: this.isProcessing,
      currentAccountId: this.currentAccountId,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.nextRunAt,
      totalRefreshedSuccess: this.totalRefreshedSuccess,
      totalRefreshedFailed: this.totalRefreshedFailed,
      lastSummary: this.lastSummary,
    };
  }

  private scheduleNext(delayMs: number) {
    if (!this.isRunning) return;
    if (this.loopTimer) clearTimeout(this.loopTimer);

    this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.loopTimer = setTimeout(async () => {
      try {
        await this.runCycle();
      } catch (err) {
        console.error('[KeepAliveWorker] Cycle error:', err);
      } finally {
        // Schedule next check (15 minutes + small jitter 0-60s)
        const jitter = Math.floor(Math.random() * 60000);
        this.scheduleNext(this.checkIntervalMs + jitter);
      }
    }, delayMs);
  }

  /**
   * Main sequential queue cycle: iterates through ALL accounts that need refresh
   */
  public async runCycle() {
    if (this.isProcessing) {
      console.log('[KeepAliveWorker] Previous cycle still in flight; skipping.');
      return;
    }

    const accounts = db.getAccounts().filter((a) => a.status === 'ACTIVE' || a.status === 'COOLDOWN');
    if (accounts.length === 0) {
      this.lastSummary = 'No active accounts in pool.';
      return;
    }

    const now = Date.now();

    // Sort accounts by least recently refreshed
    const candidates = accounts
      .map((acc) => {
        const lastRefreshed = acc.last_keepalive_at ? new Date(acc.last_keepalive_at).getTime() : 0;
        const ageMs = now - lastRefreshed;
        return { acc, ageMs };
      })
      .filter((item) => item.ageMs >= this.maxAgeMs || !item.acc.last_keepalive_at)
      .sort((a, b) => b.ageMs - a.ageMs);

    if (candidates.length === 0) {
      this.lastSummary = `All ${accounts.length} active accounts have fresh sessions (< 4 hours).`;
      return;
    }

    console.log(
      `[KeepAliveWorker] Found ${candidates.length} account(s) due for session refresh. Starting sequential queue...`
    );

    let refreshedCount = 0;
    for (const candidate of candidates) {
      if (!this.isRunning) {
        console.log('[KeepAliveWorker] Worker stopped; halting queue cycle.');
        break;
      }

      await this.refreshAccount(candidate.acc.id);
      refreshedCount++;

      // Polite sequential delay between accounts (3-6s) to avoid CPU/memory spike and allow Chromium to cleanly close
      if (refreshedCount < candidates.length && this.isRunning) {
        const jitter = 3000 + Math.floor(Math.random() * 3000);
        await new Promise((r) => setTimeout(r, jitter));
      }
    }
  }

  /**
   * Execute keep-alive on a single account with strict sequential isolation
   */
  public async refreshAccount(accountId: string): Promise<{ success: boolean; message: string }> {
    if (this.isProcessing) {
      return {
        success: false,
        message: `Worker is currently processing account "${this.currentAccountId}". Please wait for it to complete.`,
      };
    }

    if (!acquireProfileLock(accountId)) {
      return {
        success: false,
        message: `Account "${accountId}" profile is currently locked by another browser session. Skipping.`,
      };
    }

    const account = db.getAccountById(accountId);
    if (!account) {
      releaseProfileLock(accountId);
      return { success: false, message: `Account "${accountId}" not found.` };
    }

    this.isProcessing = true;
    this.currentAccountId = accountId;
    this.lastRunAt = new Date().toISOString();

    console.log(`[KeepAliveWorker] >>> Starting keep-alive for ${account.name} (${account.email_label || account.id})...`);
    db.updateAccount(accountId, { keepalive_status: 'REFRESHING' });

    let context: any = null;
    try {
      // 1. Launch isolated Chromium in Headless mode
      context = await launchStealthContext({
        accountId,
        headless: true,
        proxyUrl: account.proxy_url,
        userAgent: account.user_agent || DEFAULT_USER_AGENT,
        locale: account.locale || 'en-US',
        timezone: account.timezone || 'America/New_York',
      });

      // Reuse the persistent profile's current session whenever possible. A
      // stored cookie snapshot can be older than the profile and blindly
      // injecting it may create Google's CookieMismatch page.
      let storedCookieList: any[] = [];
      if (account.encrypted_cookie) {
        try {
          const raw = decryptCookie(account.encrypted_cookie, config.masterEncryptionKey);
          const pairs = raw.split(';').map((p) => p.trim()).filter(Boolean);
          for (const pair of pairs) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx > 0) {
              const name = pair.slice(0, eqIdx).trim();
              const value = pair.slice(eqIdx + 1).trim();
              if (name && value) {
                storedCookieList.push({
                  name,
                  value,
                  url: 'https://gemini.google.com',
                });
              }
            }
          }
        } catch (seedErr) {
          console.warn('[KeepAliveWorker] Could not decode stored cookies:', seedErr);
        }
      }

      const existingProfileCookies = await context.cookies(['https://gemini.google.com', 'https://google.com']);
      const hasExistingAuthCookie = existingProfileCookies.some(
        (cookie: any) => cookie.name === '__Secure-1PSID' || cookie.name === 'SID'
      );
      if (storedCookieList.length > 0 && !hasExistingAuthCookie) {
        await context.addCookies(storedCookieList);
      } else if (hasExistingAuthCookie) {
        console.log(`[KeepAliveWorker] Reusing authenticated persistent profile for ${account.name}.`);
      }

      const page = await context.newPage();

      // 2. Navigate to Gemini Web app
      const targetUrl = geminiAccountUrl('https://gemini.google.com/app', account.auth_user);
      let response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      const isGoogleLoginUrl = (url: string) =>
        url.includes('accounts.google.com/v3/signin') || url.includes('accounts.google.com/ServiceLogin');

      // If the persistent profile is stale, retry once with the encrypted
      // snapshot before classifying the account as expired.
      let finalUrl = page.url();
      if (isGoogleLoginUrl(finalUrl) && hasExistingAuthCookie && storedCookieList.length > 0) {
        await context.clearCookies();
        await context.addCookies(storedCookieList);
        response = await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        finalUrl = page.url();
      }

      // 3. Check for auth redirect
      if (isGoogleLoginUrl(finalUrl)) {
        console.warn(`[KeepAliveWorker] Account ${account.name} session has expired (Redirected to Google Login).`);
        db.updateAccount(accountId, {
          status: 'SESSION_EXPIRED',
          keepalive_status: 'FAILED',
          last_error: 'Google session expired: Redirected to login page during keep-alive.',
          last_error_at: new Date().toISOString(),
        });
        geminiProvider.invalidateSession(accountId);

        db.addAccountEvent({
          id: `evt_${crypto.randomBytes(8).toString('hex')}`,
          account_id: accountId,
          event_type: 'KEEPALIVE_SESSION_EXPIRED',
          from_status: account.status,
          to_status: 'SESSION_EXPIRED',
          reason: 'Google session expired or was revoked',
          created_at: new Date().toISOString(),
        });

        this.totalRefreshedFailed++;
        this.lastSummary = `Account ${account.name} failed: Session expired on Google side.`;
        return { success: false, message: 'Google session expired; account status set to SESSION_EXPIRED.' };
      }

      // A stale PSID cookie can still exist on Google's anonymous landing page.
      // Do not persist cookies unless the page exposes the authenticated Gemini
      // surface and no sign-in control is present.
      const hasAuthenticatedGeminiSurface = async () => {
        try {
          await page.waitForSelector('rich-textarea, [contenteditable="true"], textarea', { timeout: 10000 });
          return await page.evaluate(() => {
            const hasSignIn = Boolean(
              document.querySelector(
                'a[href*="ServiceLogin"], a[href*="/signin"], [aria-label="Sign in"], [data-test-id="sign-in-button"]'
              )
            );
            const hasChatSurface = Boolean(document.querySelector('rich-textarea, [contenteditable="true"], textarea'));
            const hasUserMenu = Boolean(
              document.querySelector('a[href*="SignOutOptions"], a[aria-label*="@"], button[aria-label*="@"]')
            );
            return !hasSignIn && (hasChatSurface || hasUserMenu);
          });
        } catch {
          return false;
        }
      };

      let isAuthenticatedPage = await hasAuthenticatedGeminiSurface();
      if (!isAuthenticatedPage && hasExistingAuthCookie && storedCookieList.length > 0) {
        await context.clearCookies();
        await context.addCookies(storedCookieList);
        response = await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        finalUrl = page.url();
        if (isGoogleLoginUrl(finalUrl)) {
          throw new Error('SESSION_EXPIRED: Gemini redirected to Google login after cookie recovery');
        }
        isAuthenticatedPage = await hasAuthenticatedGeminiSurface();
      }

      if (!isAuthenticatedPage) {
        throw new Error('SESSION_EXPIRED: Gemini page did not expose an authenticated chat surface');
      }

      // 4. Simulate subtle activity & wait 4-5s for Google to refresh __Secure-1PSIDTS
      const jitterMs = 3500 + Math.floor(Math.random() * 1500);
      await new Promise((r) => setTimeout(r, jitterMs));

      // 5. Extract latest cookies from browser context (targeted Google/Gemini domains only)
      const targetedCookies = await context.cookies(['https://gemini.google.com', 'https://google.com']);
      const validCookies = targetedCookies.filter((c: any) => {
        const domain = String(c.domain || '').replace(/^\./, '').toLowerCase();
        return domain === 'google.com' || domain === 'gemini.google.com';
      });

      const psid = validCookies.find((c: any) => c.name === '__Secure-1PSID');
      const psidts = validCookies.find((c: any) => c.name === '__Secure-1PSIDTS');

      if (!psid) {
        throw new Error('__Secure-1PSID cookie not found in context after navigation');
      }

      const cookieMap = new Map<string, string>();
      for (const c of validCookies) {
        if (!cookieMap.has(c.name) || c.domain.includes('gemini')) {
          cookieMap.set(c.name, c.value);
        }
      }
      const cookieHeader = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
      const normalized = normalizeCookieString(cookieHeader);
      const encryptedCookie = encryptCookie(normalized, config.masterEncryptionKey);
      const nowStr = new Date().toISOString();


      db.updateAccount(accountId, {
        status: account.status === 'SESSION_EXPIRED' ? 'ACTIVE' : account.status,
        encrypted_cookie: encryptedCookie,
        last_keepalive_at: nowStr,
        keepalive_status: 'SUCCESS',
        last_success_at: nowStr,
        consecutive_errors: 0,
        last_error: null,
      });

      geminiProvider.invalidateSession(accountId);

      db.addAccountEvent({
        id: `evt_${crypto.randomBytes(8).toString('hex')}`,
        account_id: accountId,
        event_type: 'KEEPALIVE_SUCCESS',
        from_status: account.status,
        to_status: account.status,
        reason: `Refreshed __Secure-1PSIDTS token (TS present: ${Boolean(psidts)})`,
        created_at: nowStr,
      });

      this.totalRefreshedSuccess++;
      this.lastSummary = `Successfully refreshed tokens for ${account.name} at ${new Date().toLocaleTimeString()}.`;
      console.log(`[KeepAliveWorker] <<< Completed keep-alive for ${account.name} successfully.`);

      return {
        success: true,
        message: `Successfully refreshed cookies for "${account.name}".`,
      };
    } catch (err: any) {
      console.error(`[KeepAliveWorker] Failed keep-alive for ${account.name}:`, err.message);
      const nowStr = new Date().toISOString();
      const isSessionExpired = String(err.message || '').includes('SESSION_EXPIRED');

      db.updateAccount(accountId, {
        ...(isSessionExpired ? { status: 'SESSION_EXPIRED' as const } : {}),
        keepalive_status: 'FAILED',
        last_error: `Keep-alive error: ${err.message}`,
        last_error_at: nowStr,
      });

      if (isSessionExpired) {
        geminiProvider.invalidateSession(accountId);
      }

      db.addAccountEvent({
        id: `evt_${crypto.randomBytes(8).toString('hex')}`,
        account_id: accountId,
        event_type: 'KEEPALIVE_FAILED',
        from_status: account.status,
        to_status: isSessionExpired ? 'SESSION_EXPIRED' : account.status,
        reason: `Keep-alive error: ${err.message}`,
        created_at: nowStr,
      });

      this.totalRefreshedFailed++;
      this.lastSummary = `Keep-alive error on ${account.name}: ${err.message}`;
      return { success: false, message: `Keep-alive failed: ${err.message}` };
    } finally {
      // 6. STRICT RAM CLEANUP: Always close browser context immediately
      if (context) {
        try {
          await context.close();
        } catch (closeErr) {
          console.warn('[KeepAliveWorker] Error closing context:', closeErr);
        }
      }
      releaseProfileLock(accountId);
      this.isProcessing = false;
      this.currentAccountId = null;
    }
  }
}

export const keepAliveWorker = new KeepAliveWorker();
