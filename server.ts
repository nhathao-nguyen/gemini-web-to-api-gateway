import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import os from 'os';
import { config } from './server/config.js';
import { openaiRouter } from './server/routes/openai-routes.js';
import { adminRouter } from './server/routes/admin-routes.js';
import { observabilityRouter } from './server/routes/observability-routes.js';

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
  const app = express();
  const PORT = config.port || 3000;
  const HOST = config.host || '0.0.0.0';

  // Standard middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

  // Vite middleware for frontend development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
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
}

startServer().catch((err) => {
  console.error('Fatal error starting gateway server:', err);
  process.exit(1);
});
