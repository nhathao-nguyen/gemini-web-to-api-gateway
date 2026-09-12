import fs from 'fs';
import path from 'path';

export interface DesktopAppConfig {
  /** Expose /v1 on LAN (0.0.0.0). Off = loopback only. Requires restart. */
  shareLan: boolean;
  /** Gateway HTTP port. Requires restart. */
  port: number;
}

const DEFAULTS: DesktopAppConfig = { shareLan: false, port: 3000 };

export function desktopConfigPath(userDataDir: string): string {
  return path.join(userDataDir, 'app-config.json');
}

export function desktopConfigExists(userDataDir: string): boolean {
  try {
    return fs.existsSync(desktopConfigPath(userDataDir));
  } catch {
    return false;
  }
}

export function loadAppConfig(userDataDir: string): DesktopAppConfig {
  try {
    const file = path.join(userDataDir, 'app-config.json');
    if (!fs.existsSync(file)) return { ...DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      shareLan: Boolean(raw.shareLan ?? DEFAULTS.shareLan),
      port: Number.isFinite(Number(raw.port)) ? Number(raw.port) : DEFAULTS.port,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAppConfig(userDataDir: string, cfg: DesktopAppConfig): DesktopAppConfig {
  const clean: DesktopAppConfig = {
    shareLan: Boolean(cfg.shareLan),
    port: Number.isFinite(Number(cfg.port)) ? Number(cfg.port) : DEFAULTS.port,
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(desktopConfigPath(userDataDir), JSON.stringify(clean, null, 2));
  return clean;
}
