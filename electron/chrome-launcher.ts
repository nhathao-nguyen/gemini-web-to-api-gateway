import { spawn } from 'child_process';
import { shell } from 'electron';
import { findUserChrome } from '../server/services/browser-manager/profile-snapshot.js';

export { findUserChrome };

/**
 * Open a URL in the user's real Chrome. If Chrome is already running, the OS
 * hands the URL to that instance (new window/tab, same profile and Google
 * sessions) instead of starting a fresh browser. Falls back to the default
 * browser when Chrome cannot be located.
 */
export async function openUrlInUserChrome(url: string): Promise<{ chromePath?: string; fallback: boolean }> {
  const chromePath = await findUserChrome();
  if (chromePath) {
    try {
      const child = spawn(chromePath, [url], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return { chromePath, fallback: false };
    } catch (err) {
      console.warn(`[ChromeLauncher] Failed to launch ${chromePath}, falling back to default browser:`, (err as Error).message);
    }
  }
  await shell.openExternal(url);
  return { fallback: true };
}
