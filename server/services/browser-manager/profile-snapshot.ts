import { spawn, execFile } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { chromium } from 'playwright-extra';

const execFileAsync = promisify(execFile);

/**
 * Capture Google session cookies from the user's REAL Chrome without any
 * extension and without touching the running instance:
 *
 * 1. Copy the (small) cookie files + Local State into a temp snapshot dir.
 * 2. Launch headless chrome.exe on that snapshot with a debug port.
 * 3. Read cookies over CDP (Chrome decrypts its own DPAPI cookies itself).
 * 4. Kill the snapshot browser and delete the snapshot.
 *
 * The running Chrome is never attached to, locked, or modified.
 */

// ---------- Chrome discovery (shared, no Electron dependency) ----------

function uniqueExisting(paths: Array<string | undefined>): string | undefined {
  const seen = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    const normalized = path.normalize(p);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      if (fs.existsSync(normalized)) return normalized;
    } catch {
      // Ignore unreadable paths.
    }
  }
  return undefined;
}

async function queryRegistryChromePath(hive: 'HKLM' | 'HKCU'): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('reg', [
      'query',
      `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`,
      '/ve',
    ]);
    const m = stdout.match(/REG_SZ\s+(.+?)\s*$/m);
    const candidate = m?.[1]?.trim();
    if (candidate && fs.existsSync(candidate)) return candidate;
  } catch {
    // reg.exe missing or key absent.
  }
  return undefined;
}

/** Locate the user's real Google Chrome executable on Windows. */
export async function findUserChrome(): Promise<string | undefined> {
  const override = (process.env.GATEWAY_CHROME_PATH || '').trim();
  if (override && fs.existsSync(override)) return override;

  const fromRegHKLM = await queryRegistryChromePath('HKLM');
  if (fromRegHKLM) return fromRegHKLM;
  const fromRegHKCU = await queryRegistryChromePath('HKCU');
  if (fromRegHKCU) return fromRegHKCU;

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LocalAppData || '';
  const found = uniqueExisting([
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
  ]);
  if (found) return found;

  try {
    const { stdout } = await execFileAsync('where', ['chrome']);
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  } catch {
    // `where` failed — no Chrome on PATH.
  }
  return undefined;
}

/** Locate the user's real Chrome profile root (User Data). */
export function findChromeUserDataDir(): string | undefined {
  const override = (process.env.GATEWAY_CHROME_PROFILE || '').trim();
  if (override && fs.existsSync(override)) return override;
  const localAppData = process.env.LocalAppData || process.env.LOCALAPPDATA || '';
  const candidate = localAppData ? path.join(localAppData, 'Google', 'Chrome', 'User Data') : undefined;
  if (candidate) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore.
    }
  }
  return undefined;
}

// ---------- Snapshot helpers (pure filesystem, fully unit-testable) ----------

/** Profile dirs (relative names) that actually hold a cookie store. */
export function listChromeProfiles(userDataDir: string): string[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(userDataDir);
  } catch {
    return [];
  }
  const profiles: string[] = [];
  for (const name of entries) {
    if (name !== 'Default' && !/^Profile \d+$/.test(name)) continue;
    const dir = path.join(userDataDir, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (
      fs.existsSync(path.join(dir, 'Network', 'Cookies')) ||
      fs.existsSync(path.join(dir, 'Cookies'))
    ) {
      profiles.push(name);
    }
  }
  // Deterministic order: Default first, then Profile N ascending.
  profiles.sort((a, b) => {
    if (a === 'Default') return -1;
    if (b === 'Default') return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  return profiles;
}

/** Relative files needed for Chrome to open the snapshot cookie store. */
export function snapshotFileList(profile: string): string[] {
  return [
    'Local State',
    path.join(profile, 'Network', 'Cookies'),
    path.join(profile, 'Network', 'Cookies-journal'),
    path.join(profile, 'Network', 'Cookies-wal'),
    path.join(profile, 'Cookies'),
    path.join(profile, 'Cookies-journal'),
    path.join(profile, 'Cookies-wal'),
  ];
}

export type CopyStatus = 'ok' | 'locked' | 'missing' | 'error';

export function copyFileStatus(src: string, dest: string): CopyStatus {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return 'ok';
  } catch (err: any) {
    const code = err?.code || '';
    const msg = String(err?.message || '');
    if (code === 'EBUSY' || code === 'EPERM' || /busy or locked/i.test(msg)) return 'locked';
    if (code === 'ENOENT') return 'missing';
    if (!fs.existsSync(src)) return 'missing';
    return 'error';
  }
}

export interface SnapshotOutcome {
  ok: boolean;
  /** True when the running Chrome holds an exclusive lock on its cookie DB. */
  locked: boolean;
}

/**
 * Copy cookie files (with a few retries — the running Chrome may be writing).
 * Chrome denies even reads while it runs (EBUSY): in that case `locked` is
 * true and the caller must ask the user to close Chrome or use the extension.
 */
export function snapshotProfileFiles(
  userDataDir: string,
  profile: string,
  destDir: string,
  attempts = 4
): SnapshotOutcome {
  let sawLocked = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    copyFileStatus(path.join(userDataDir, 'Local State'), path.join(destDir, 'Local State'));
    let cookiesCopied = false;
    for (const rel of snapshotFileList(profile)) {
      if (rel === 'Local State') continue;
      const st = copyFileStatus(path.join(userDataDir, rel), path.join(destDir, rel));
      if (st === 'locked') sawLocked = true;
      if (st === 'ok' && /(^|[\\/])Cookies$/.test(rel)) cookiesCopied = true;
    }
    if (cookiesCopied && fs.existsSync(path.join(destDir, 'Local State'))) {
      return { ok: true, locked: false };
    }
    sleepSync(400);
  }
  const ok =
    fs.existsSync(path.join(destDir, 'Local State')) &&
    (fs.existsSync(path.join(destDir, profile, 'Network', 'Cookies')) ||
      fs.existsSync(path.join(destDir, profile, 'Cookies')));
  return { ok, locked: !ok && sawLocked };
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Brief spin; only used between snapshot retries.
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForDebugPort(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Snapshot Chrome debug port did not come up in time');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Merge cookie lists into one header; later entries win on name clash. */
export function mergeCookiesToHeader(cookies: Array<{ name: string; value: string }>): string {
  const map = new Map<string, string>();
  for (const c of cookies) {
    if (c.name) map.set(c.name, c.value);
  }
  const parts: string[] = [];
  for (const [name, value] of map.entries()) {
    parts.push(`${name}=${value}`);
  }
  return parts.join('; ');
}

function removeDirBestEffort(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      sleepSync(400);
    }
  }
}

// ---------- Orchestrator ----------

export interface SnapshotCaptureResult {
  cookieHeader: string;
  profile: string | null;
}

/**
 * Read Google cookies from the user's real Chrome profiles via a throwaway
 * headless snapshot. Returns a merged cookie header (google.com +
 * gemini.google.com scopes). Throws a user-actionable error when no usable
 * Google session exists in any profile.
 */
export async function captureGoogleCookiesFromUserChrome(): Promise<SnapshotCaptureResult> {
  const chromePath = await findUserChrome();
  if (!chromePath) {
    throw new Error('Không tìm thấy Chrome trên máy. Hãy cài Google Chrome hoặc dùng “cửa sổ app”.');
  }
  const userDataDir = findChromeUserDataDir();
  if (!userDataDir) {
    throw new Error('Không tìm thấy thư mục profile của Chrome. Hãy mở Chrome ít nhất một lần rồi thử lại.');
  }
  const profiles = listChromeProfiles(userDataDir);
  if (profiles.length === 0) {
    throw new Error('Không thấy profile Chrome nào có cookie. Hãy mở Chrome và đăng nhập Google trước.');
  }

  const merged = new Map<string, string>();
  let usedProfile: string | null = null;
  let lastError: string | null = null;
  let sawLocked = false;

  for (const profile of profiles) {
    const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-chrome-snap-'));
    let browser: any = null;
    try {
      const snap = snapshotProfileFiles(userDataDir, profile, snapDir);
      if (snap.locked) sawLocked = true;
      if (!snap.ok) {
        if (!snap.locked) lastError = `Không đọc được cookie của profile ${profile}.`;
        continue;
      }
      const port = await findFreePort();
      const child = spawn(
        chromePath,
        [
          '--headless=new',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-gpu',
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${snapDir}`,
          `--profile-directory=${profile}`,
          'about:blank',
        ],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
      try {
        await waitForDebugPort(port);
        browser = await (chromium as any).connectOverCDP(`http://127.0.0.1:${port}`);
        const contexts = browser.contexts();
        for (const ctx of contexts) {
          const cookies = await ctx.cookies().catch(() => []);
          for (const c of cookies) {
            const domain = String(c.domain || '');
            if (domain.includes('google.com') || domain.includes('gemini.google.com')) {
              if (c.name) merged.set(c.name, c.value);
            }
          }
        }
        if ([...merged.keys()].some((n) => n === '__Secure-1PSID' || n === 'SID')) {
          usedProfile = profile;
        }
      } finally {
        try {
          await browser?.close()?.catch(() => undefined);
        } catch {
          // Ignore close errors; snapshot dir cleanup follows.
        }
      }
    } catch (err: any) {
      lastError = err?.message || String(err);
    } finally {
      removeDirBestEffort(snapDir);
    }
    if (usedProfile) break;
  }

  if (!usedProfile || merged.size === 0) {
    if (sawLocked) {
      throw new Error(
        'CHROME_LOCKED: Chrome đang mở nên file cookie bị khóa, app không đọc được. ' +
          'Chọn 1 trong 2: (1) Tắt hẳn Chrome (kiểm tra khay hệ thống) rồi bấm Xác nhận lại; ' +
          '(2) khỏi cần tắt — bấm icon extension “Gemini Gateway” → “Gửi session về app”.'
      );
    }
    throw new Error(
      'Không thấy phiên Google nào trong Chrome. Hãy mở Chrome, đăng nhập Google ở gemini.google.com, rồi bấm Xác nhận lại.' +
        (lastError ? ` (${lastError})` : '')
    );
  }

  const parts: string[] = [];
  for (const [name, value] of merged.entries()) {
    parts.push(`${name}=${value}`);
  }
  return { cookieHeader: parts.join('; '), profile: usedProfile };
}
