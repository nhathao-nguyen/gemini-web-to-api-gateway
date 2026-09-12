import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

async function boot(): Promise<void> {
  const userDataDir = app.getPath('userData');

  // Snapshot shell-provided HOST BEFORE any server module (and dotenv)
  // is evaluated, so a stale .env file can never silently force LAN mode.
  const explicitHost = process.env.HOST;

  // MUST be set before any server module is evaluated (config reads it at import).
  process.env.GATEWAY_DATA_DIR = userDataDir;

  const { loadAppConfig, desktopConfigExists } = await import('./app-config.js');
  if (desktopConfigExists(userDataDir)) {
    // Saved Settings toggle is authoritative (applied on restart).
    const appConfig = loadAppConfig(userDataDir);
    process.env.SHARE_LAN = appConfig.shareLan ? '1' : '0';
    process.env.PORT = String(appConfig.port);
    process.env.HOST = appConfig.shareLan ? '0.0.0.0' : '127.0.0.1';
  } else if (!explicitHost) {
    // First run: loopback-only by default, even if a repo .env says 0.0.0.0.
    // (PORT still follows explicit env / .env / default 3000.)
    process.env.HOST = '127.0.0.1';
  }
  // Profile dirs for KeepAlive's headless Chromium live under userData.
  process.env.GATEWAY_PROFILE_DIR = path.join(userDataDir, 'browser-profiles');

  const { startGatewayServer } = await import('../server.js');
  const { registerIpcHandlers } = await import('./ipc.js');
  const { registerLoginIpc } = await import('./login-ipc.js');

  const { server } = await startGatewayServer();
  const address = server.address();
  const { config } = await import('../server/config.js');
  const port = typeof address === 'object' && address ? address.port : config.port;
  const gatewayUrl = `http://127.0.0.1:${port}`;

  registerIpcHandlers(userDataDir, { url: gatewayUrl });
  registerLoginIpc();

  const createMainWindow = () => {
    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      show: true,
      title: 'Gemini Gateway (Desktop)',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: [`--gateway-url=${gatewayUrl}`],
      },
    });

    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
      win.loadURL(devUrl);
    } else {
      win.loadFile(path.join(process.cwd(), 'dist', 'index.html'));
    }
    return win;
  };

  await app.whenReady();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

async function shutdown(): Promise<void> {
  try {
    const { keepAliveWorker } = await import('../server/services/browser-manager/keepalive-worker.js');
    keepAliveWorker.stop();
  } catch {
    // Best-effort.
  }
  try {
    const { closeAllLoginWindows } = await import('./login.js');
    closeAllLoginWindows();
  } catch {
    // Best-effort.
  }
  try {
    const { db } = await import('../server/db/database.js');
    db.close();
  } catch {
    // Best-effort.
  }
}

// Single instance: a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const win = wins[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      void shutdown().finally(() => app.quit());
    }
  });

  app.on('before-quit', () => {
    void shutdown();
  });

  boot().catch((err) => {
    console.error('Fatal error starting desktop gateway:', err);
    app.quit();
  });
}
