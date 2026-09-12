import { ipcMain, BrowserWindow } from 'electron';
import {
  startDesktopLogin,
  getDesktopLoginSession,
  confirmDesktopLogin,
  cancelDesktopLogin,
  setLoginEvents,
} from './login.js';

function wrap(fn: (args: any) => Promise<any> | any) {
  return async (_event: any, args: any) => {
    try {
      return { ok: true, data: await fn(args || {}) };
    } catch (err: any) {
      const msg = err?.message ? String(err.message) : 'Desktop login error';
      return { ok: false, error: msg, code: msg.includes('NOT_FOUND') ? 'NOT_FOUND' : undefined };
    }
  };
}

export function registerLoginIpc(): void {
  // Push session updates to every renderer window (progress UI).
  setLoginEvents({
    onUpdate: (session) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.webContents.send('gw:login-event', session);
        } catch {
          // Window may be closing — ignore.
        }
      }
    },
  });

  ipcMain.handle(
    'gw:login:start',
    wrap(({ accountId, mode, name, emailLabel, proxyUrl, priority, weight }) =>
      startDesktopLogin({ accountId, mode: mode === 'external' ? 'external' : 'window', name, emailLabel, proxyUrl, priority, weight })
    )
  );
  ipcMain.handle(
    'gw:login:status',
    wrap(({ sessionId }) => {
      const session = getDesktopLoginSession(sessionId);
      if (!session) throw new Error('NOT_FOUND: Login session not found or expired');
      return session;
    })
  );
  ipcMain.handle('gw:login:confirm', wrap(({ sessionId }) => confirmDesktopLogin(sessionId)));
  ipcMain.handle('gw:login:cancel', wrap(async ({ sessionId }) => ({ success: await cancelDesktopLogin(sessionId) })));
}
