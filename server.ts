import express from 'express';
import cors from 'cors';
import os from 'os';
import { setGlobalDispatcher, Agent } from 'undici';
import { config } from './server/config.js';
import { db } from './server/db/database.js';
import { openaiRouter } from './server/routes/openai-routes.js';
import { observabilityRouter } from './server/routes/observability-routes.js';
import { internalCaptureRouter } from './server/routes/internal-capture-routes.js';
import { keepAliveWorker } from './server/services/browser-manager/keepalive-worker.js';

// Configure Undici global dispatcher with generous header buffer for Gemini Web large cookie payloads
setGlobalDispatcher(
  new Agent({
    maxHeaderSize: 262144, // 256 KB
    headersTimeout: 60000,
  })
);

function getLanIpv4(): string | null {
  const interfaces = os.networkInterfaces();
  // First look for typical LAN subnets (192.168.x.x, 10.x.x.x)
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        if (net.address.startsWith('192.168.') || net.address.startsWith('10.')) {
          return net.address;
        }
      }
    }
  }
  // Fallback to any non-internal IPv4
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

/**
 * Desktop gateway app: serves ONLY the OpenAI-compatible /v1 API for LAN
 * clients plus minimal observability (/health, /ready, /metrics).
 * There is no admin website — desktop UI talks to services via Electron IPC.
 */
export function buildGatewayApp() {
  const app = express();

  // Standard middleware
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Handle JSON parsing errors and payload limits cleanly without process crash
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'status' in err && (err as any).status === 400 && 'body' in err) {
      return res.status(400).json({
        error: {
          message: 'Invalid JSON payload received in request body.',
          type: 'invalid_request_error',
          code: 'invalid_json',
        },
      });
    }
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json({
        error: {
          message: 'Request payload exceeds the maximum allowed limit.',
          type: 'invalid_request_error',
          code: 'payload_too_large',
        },
      });
    }
    next(err);
  });

  // CORS: open/configurable for /v1 LAN clients, open for observability.
  const v1CorsOptions: cors.CorsOptions = {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
  };

  const obsCorsOptions: cors.CorsOptions = {
    origin: '*',
    methods: ['GET', 'OPTIONS'],
  };

  // Access logger for API traffic
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/v1')) {
        console.log(`[HTTP] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
      }
    });
    next();
  });

  // Observability endpoints (root health & /observability)
  app.use('/observability', cors(obsCorsOptions), observabilityRouter);
  app.use('/', cors(obsCorsOptions), observabilityRouter);

  // OpenAI-compatible API at /v1
  app.use('/v1', cors(v1CorsOptions), openaiRouter);

  // Companion endpoints for the Chrome extension login-capture flow.
  // Delivery is authorized by single-use capture tokens minted per session.
  app.use('/internal', cors(v1CorsOptions), internalCaptureRouter);

  // Catch-all 404 handler for API routes (always JSON, never HTML)
  app.use(['/v1', '/observability', '/internal'], (req, res) => {
    res.status(404).json({
      error: {
        message: `API endpoint ${req.method} ${req.originalUrl} not found`,
        code: 'endpoint_not_found',
      },
    });
  });

  // Global Express error handler (must have 4 arguments)
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(`[HTTP Error] ${req.method} ${req.path}:`, err?.message || err);
    if (res.headersSent) {
      return next(err);
    }
    const statusCode = err.status || err.statusCode || 500;
    res.status(statusCode).json({
      error: {
        message: err.message || 'Internal server error',
        type: err.type || 'server_error',
        code: err.code || 'internal_error',
      },
    });
  });

  return app;
}

export interface GatewayListenOptions {
  port?: number;
  host?: string;
}

export async function startGatewayServer(options: GatewayListenOptions = {}) {
  // Database init is synchronous (SQLite) but kept awaitable for compat.
  await db.init();

  // Hourly retention so local logs/events cannot grow forever.
  db.startRetentionScheduler();

  // Start Headless Browser Session Pool & Keep-Alive Worker
  keepAliveWorker.start();

  const app = buildGatewayApp();
  const PORT = options.port ?? config.port ?? 3000;
  const HOST = options.host ?? config.host;

  const server = app.listen(PORT, HOST, () => {
    const lanIp = getLanIpv4();
    console.log(`====================================================`);
    console.log(`🚀 Gemini Web-to-API Gateway (desktop)`);
    console.log(`📡 Gateway listening on ${HOST}:${PORT}`);
    if (HOST === '0.0.0.0' && lanIp) {
      console.log(`🌐 LAN URL:          http://${lanIp}:${PORT}`);
      console.log(`🤖 OpenAI Base URL:  http://${lanIp}:${PORT}/v1`);
    } else {
      console.log(`🤖 Local OpenAI URL: http://127.0.0.1:${PORT}/v1`);
    }
    console.log(`📊 Health Endpoint:  http://${HOST}:${PORT}/health`);
    console.log(`====================================================`);
  });

  server.on('error', (err: any) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `[Server] Port ${PORT} is already in use. Close the other instance or change the port (Settings in the desktop app, or PORT env).`
      );
    } else {
      console.error('[Server] Listen error:', err?.message || err);
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
    keepAliveWorker.stop();
    if (server) {
      server.close();
    }
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    console.error('[Process] Uncaught Exception:', err);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
  });

  return { app, server };
}

// Standalone mode (`npm run dev` / `node dist/server.cjs`): loopback by
// default, LAN only with SHARE_LAN=1. Skipped when imported (Electron main
// boots the gateway explicitly via startGatewayServer()).
const isDirectRun = (() => {
  try {
    const req: any = typeof require !== 'undefined' ? require : undefined;
    const mod: any = typeof module !== 'undefined' ? module : undefined;
    if (req?.main && mod) return req.main === mod;
  } catch {
    // ignore — fall through to argv check
  }
  const entry = process.argv[1] || '';
  return entry.endsWith('server.ts') || entry.endsWith('server.cjs');
})();

if (isDirectRun) {
  startGatewayServer().catch((err) => {
    console.error('Fatal error starting gateway server:', err);
    process.exit(1);
  });
}
