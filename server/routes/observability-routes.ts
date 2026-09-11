import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { accountScheduler } from '../services/scheduler.js';

export const observabilityRouter = Router();

observabilityRouter.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

observabilityRouter.get('/ready', (req: Request, res: Response) => {
  const isDbOk = db.isPostgresConnected() || !process.env.DATABASE_URL;
  const redisDiag = rateLimiter.getDiagnostics();
  const isRedisOk = redisDiag.connected || !process.env.REDIS_URL;

  const dbStatus = db.isPostgresConnected() ? 'ok' : (!process.env.DATABASE_URL ? 'ok' : 'degraded');
  const redisStatus = redisDiag.connected ? 'ok' : (!process.env.REDIS_URL ? 'ok' : 'degraded');

  const isReady = isDbOk && isRedisOk;

  return res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'degraded',
    database: dbStatus,
    redis: redisStatus,
  });
});

observabilityRouter.get('/metrics', (req: Request, res: Response) => {
  const analytics = db.getAnalytics();
  const accounts = db.getAccounts();

  const activeAccounts = accounts.filter((a) => a.status === 'ACTIVE').length;
  const cooldownAccounts = accounts.filter((a) => a.status === 'COOLDOWN' || a.status === 'QUOTA_EXHAUSTED').length;
  const expiredAccounts = accounts.filter((a) => a.status === 'SESSION_EXPIRED').length;

  const lines = [
    '# HELP gateway_requests_total Total requests processed by the gateway',
    '# TYPE gateway_requests_total counter',
    `gateway_requests_total ${analytics.totalRequests}`,
    '',
    '# HELP gateway_requests_success Total successful requests',
    '# TYPE gateway_requests_success counter',
    `gateway_requests_success ${analytics.successfulRequests}`,
    '',
    '# HELP gateway_requests_error Total failed requests',
    '# TYPE gateway_requests_error counter',
    `gateway_requests_error ${analytics.errorRequests}`,
    '',
    '# HELP gateway_request_duration_ms Average request latency in milliseconds',
    '# TYPE gateway_request_duration_ms gauge',
    `gateway_request_duration_ms ${analytics.avgLatency}`,
    '',
    '# HELP active_accounts Number of accounts currently in ACTIVE status',
    '# TYPE active_accounts gauge',
    `active_accounts ${activeAccounts}`,
    '',
    '# HELP cooldown_accounts Number of accounts in COOLDOWN or QUOTA_EXHAUSTED',
    '# TYPE cooldown_accounts gauge',
    `cooldown_accounts ${cooldownAccounts}`,
    '',
    '# HELP expired_accounts Number of accounts in SESSION_EXPIRED',
    '# TYPE expired_accounts gauge',
    `expired_accounts ${expiredAccounts}`,
  ];

  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(lines.join('\n') + '\n');
});
