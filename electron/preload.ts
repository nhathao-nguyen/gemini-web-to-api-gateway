import { contextBridge, ipcRenderer } from 'electron';

/**
 * Desktop bridge: renderer calls main-process gateway services via IPC.
 * No HTTP, no cookies, no CSRF — the window is local and trusted.
 */
contextBridge.exposeInMainWorld('gateway', {
  invoke: (channel: string, args?: any) => ipcRenderer.invoke(channel, args),
  onLoginEvent: (listener: (session: any) => void) => {
    const wrapped = (_event: any, session: any) => listener(session);
    ipcRenderer.on('gw:login-event', wrapped);
    return () => ipcRenderer.removeListener('gw:login-event', wrapped);
  },
});

// Injected by main via additionalArguments (--gateway-url=...).
const gatewayUrlArg = process.argv.find((a) => a.startsWith('--gateway-url='));
if (gatewayUrlArg) {
  (globalThis as any).__gatewayUrl = gatewayUrlArg.slice('--gateway-url='.length);
}
contextBridge.exposeInMainWorld('gatewayUrl', (globalThis as any).__gatewayUrl || '');
