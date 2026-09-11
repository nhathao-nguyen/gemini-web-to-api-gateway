import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import os from 'os';
import { setGlobalDispatcher, Agent } from 'undici';
import { config } from './server/config.js';
import { db } from './server/db/database.js';
import { openaiRouter } from './server/routes/openai-routes.js';
import { adminRouter } from './server/routes/admin-routes.js';
import { observabilityRouter } from './server/routes/observability-routes.js';
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

async function startServer() {
  // Ensure database initialization is complete before accepting traffic
  await db.init();

  // Start Headless Browser Session Pool & Keep-Alive Worker
  keepAliveWorker.start();

  const app = express();
  const PORT = config.port || 3000;
  const HOST = config.host || '0.0.0.0';

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

  // CORS definitions
  // 1. Strict CORS for Admin routes - NEVER wildcard '*'
  const adminCorsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
      if (!origin) {
        // Same-origin, direct browser navigation, curl, or server-to-server
        return callback(null, true);
      }
      if (config.corsOrigins.length > 0) {
        if (config.corsOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`Origin ${origin} not permitted by admin CORS policy`), false);
      }
      // Without explicit CORS_ORIGINS, reject foreign cross-origin admin requests
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key', 'X-Admin-Password', 'X-CSRF-Token'],
  };

  // 2. Open / Configurable CORS for public /v1 OpenAI API endpoints
  const v1CorsOptions: cors.CorsOptions = {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
  };

  // 3. Public CORS for observability
  const obsCorsOptions: cors.CorsOptions = {
    origin: '*',
    methods: ['GET', 'OPTIONS'],
  };

  // Request ID & access logger
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/v1') || req.path.startsWith('/api/admin')) {
        console.log(`[HTTP] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
      }
    });
    next();
  });

  // Mount Observability endpoints (root health & /observability)
  app.use('/observability', cors(obsCorsOptions), observabilityRouter);
  app.use('/', cors(obsCorsOptions), observabilityRouter);

  // Mount OpenAI-compatible API at /v1
  app.use('/v1', cors(v1CorsOptions), openaiRouter);

  // Mount Admin Dashboard API at /admin and /api/admin
  app.use('/admin', cors(adminCorsOptions), adminRouter);
  app.use('/api/admin', cors(adminCorsOptions), adminRouter);

  // Catch-all 404 handler for API routes (ensures API routes NEVER return HTML SPA fallback)
  app.use(['/api', '/admin', '/v1', '/observability'], (req, res) => {
    res.status(404).json({
      error: {
        message: `API endpoint ${req.method} ${req.originalUrl} not found`,
        code: 'endpoint_not_found',
      },
    });
  });

  // Vite middleware for frontend development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        watch: {
          ignored: [
            '**/browser-profiles/**',
            '**/scratch/**',
            '**/e2e_evidence/**',
            '**/*.db*',
            '**/*.sqlite*',
            '**/node_modules/**',
          ],
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      // Safeguard: Do NOT catch API or observability endpoints
      if (
        req.path.startsWith('/api') ||
        req.path.startsWith('/admin') ||
        req.path.startsWith('/v1') ||
        req.path.startsWith('/observability') ||
        req.path === '/health' ||
        req.path === '/ready' ||
        req.path === '/metrics'
      ) {
        return res.status(404).json({ error: 'Endpoint not found' });
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

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

  const server = app.listen(PORT, HOST, () => {
    const lanIp = getLanIpv4();
    console.log(`====================================================`);
    console.log(`🚀 Gemini Web-to-API Gateway Server`);
    console.log(`📡 Gateway listening on ${HOST}:${PORT}`);
    if (lanIp) {
      console.log(`🌐 LAN URL:          http://${lanIp}:${PORT}`);
      console.log(`🤖 OpenAI Base URL:  http://${lanIp}:${PORT}/v1`);
      console.log(`📊 Health Endpoint:  http://${lanIp}:${PORT}/health`);
      console.log(`📈 Ready Endpoint:   http://${lanIp}:${PORT}/ready`);
    } else {
      console.log(`🤖 Local OpenAI URL: http://localhost:${PORT}/v1`);
      console.log(`📊 Health Endpoint:  http://localhost:${PORT}/health`);
    }
    console.log(`====================================================`);
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
}

startServer().catch((err) => {
  console.error('Fatal error starting gateway server:', err);
  process.exit(1);
});
