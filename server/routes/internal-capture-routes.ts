import { Router, Request, Response, NextFunction } from 'express';
import {
  listPendingLogins,
  consumeCaptureToken,
  completeLoginWithCookie,
  refreshCaptureToken,
} from '../services/browser-manager/desktop-login-store.js';

/**
 * Companion endpoints for the Chrome extension + desktop login flow.
 * Everything here is loopback-only: the extension always runs on the same
 * machine as the app, so LAN clients are rejected even in SHARE_LAN mode.
 * Cookie delivery additionally requires a 256-bit random, single-use,
 * 5-minute capture token minted per login session.
 */
export const internalCaptureRouter = Router();

function isLoopback(req: Request): boolean {
  const ip = String(req.ip || req.socket?.remoteAddress || '').toLowerCase();
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

internalCaptureRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (!isLoopback(req)) {
    return res.status(403).json({ success: false, error: 'Internal endpoints accept loopback connections only' });
  }
  next();
});

internalCaptureRouter.get('/login-pending', (req: Request, res: Response) => {
  return res.json({ pending: listPendingLogins() });
});

internalCaptureRouter.post('/login-token', (req: Request, res: Response) => {
  const { sessionId } = req.body || {};
  const token = sessionId ? refreshCaptureToken(String(sessionId)) : undefined;
  if (!token) {
    return res.status(404).json({ success: false, error: 'Phiên đăng nhập không tồn tại, đã xong hoặc hết hạn' });
  }
  return res.json({ success: true, token });
});

internalCaptureRouter.post('/gemini-capture', (req: Request, res: Response) => {
  const { token, cookie } = req.body || {};
  if (!token || !cookie) {
    return res.status(400).json({ success: false, error: 'Capture token and cookie are required' });
  }
  const session = consumeCaptureToken(String(token));
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Token không hợp lệ hoặc đã dùng/hết hạn. Hãy bấm “Đăng nhập” trong app để tạo phiên mới.',
    });
  }
  try {
    const completed = completeLoginWithCookie(session.sessionId, String(cookie));
    const { captureToken, ...safe } = completed;
    return res.json({ success: true, session: safe });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message || 'Failed to save session' });
  }
});
