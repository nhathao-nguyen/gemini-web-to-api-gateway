import { chromium } from 'playwright-extra';
import type { BrowserContext } from 'playwright';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

let isStealthInitialized = false;

export function ensureStealthInitialized(): void {
  if (!isStealthInitialized) {
    chromium.use(stealthPlugin());
    isStealthInitialized = true;
  }
}

export interface ParsedProxy {
  server: string;
  username?: string;
  password?: string;
}

const activeProfileLocks = new Set<string>();

export function acquireProfileLock(accountId: string): boolean {
  if (activeProfileLocks.has(accountId)) {
    return false;
  }
  activeProfileLocks.add(accountId);
  return true;
}

export function releaseProfileLock(accountId: string): void {
  activeProfileLocks.delete(accountId);
}

export function isProfileLocked(accountId: string): boolean {
  return activeProfileLocks.has(accountId);
}

export function parseProxy(proxyUrl?: string | null): ParsedProxy | undefined {
  if (!proxyUrl || !proxyUrl.trim()) return undefined;
  let trimmed = proxyUrl.trim();
  if (!trimmed.includes('://')) {
    trimmed = `http://${trimmed}`;
  }

  try {
    const url = new URL(trimmed);
    const server = `${url.protocol}//${url.host}`;
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;

    return { server, username, password };
  } catch {
    // If not a valid standard URL, fallback to raw string as server
    return { server: trimmed };
  }
}

export function getProfileBaseDir(): string {
  // Desktop shell points this at <userData>/browser-profiles; standalone
  // mode falls back to the working directory.
  const override = (process.env.GATEWAY_PROFILE_DIR || '').trim();
  return override || path.resolve(process.cwd(), 'browser-profiles');
}

export function getProfileDir(accountId: string): string {
  const sanitized = accountId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.resolve(getProfileBaseDir(), sanitized);
}

export async function cleanupProfileDir(accountId: string): Promise<boolean> {
  const dirPath = getProfileDir(accountId);
  if (!fs.existsSync(dirPath)) return true;

  // On Windows, Chromium processes might take a short moment to unlock files
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.warn(`[StealthFactory] Failed to remove profile dir at ${dirPath}:`, err);
    return false;
  }
}

export interface LaunchStealthOptions {
  accountId: string;
  headless?: boolean;
  proxyUrl?: string | null;
  userAgent?: string | null;
  locale?: string | null;
  timezone?: string | null;
}

export async function launchStealthContext(options: LaunchStealthOptions): Promise<BrowserContext> {
  ensureStealthInitialized();

  const profileDir = getProfileDir(options.accountId);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  const proxyConfig = parseProxy(options.proxyUrl);

  const isHeaded = options.headless === false;

  const launchOptions: any = {
    headless: !isHeaded,
    proxy: proxyConfig,
    userAgent: options.userAgent || DEFAULT_USER_AGENT,
    locale: options.locale || 'en-US',
    timezoneId: options.timezone || 'America/New_York',
    viewport: isHeaded ? null : { width: 1280, height: 800 },
    ignoreHTTPSErrors: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      ...(isHeaded
        ? [
            '--new-window',
            '--start-maximized',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-notifications',
            '--window-position=50,50',
          ]
        : ['--window-size=1280,800']),
    ],
  };

  if (
    fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ||
    fs.existsSync('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe')
  ) {
    launchOptions.channel = 'chrome';
  }

  const context = (await chromium.launchPersistentContext(profileDir, launchOptions)) as BrowserContext;

  return context;
}

export async function testProxyConnection(proxyUrl: string): Promise<{
  success: boolean;
  ip?: string;
  latencyMs?: number;
  error?: string;
}> {
  ensureStealthInitialized();

  const proxyConfig = parseProxy(proxyUrl);
  if (!proxyConfig) {
    return { success: false, error: 'Invalid or empty proxy URL format' };
  }

  const start = Date.now();
  let tempContext: BrowserContext | null = null;
  const tempDir = path.resolve(process.cwd(), 'browser-profiles', `probe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    tempContext = (await chromium.launchPersistentContext(tempDir, {
      headless: true,
      proxy: proxyConfig,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    })) as BrowserContext;

    const page = await tempContext.newPage();
    const response = await page.goto('https://api.ipify.org?format=json', {
      timeout: 12000,
      waitUntil: 'domcontentloaded',
    });

    if (!response || !response.ok()) {
      throw new Error(`HTTP ${response?.status() || 'timeout'}`);
    }

    const text = await page.innerText('body');
    const parsed = JSON.parse(text);
    const latencyMs = Date.now() - start;

    return {
      success: true,
      ip: parsed.ip,
      latencyMs,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Proxy connection timed out or refused',
    };
  } finally {
    if (tempContext) {
      try {
        await tempContext.close();
      } catch {}
    }
    // Asynchronous cleanup of temporary probe dir with retries for Windows file lock release
    setTimeout(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }, 1000);
  }
}
