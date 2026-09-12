import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { apiKeyManager } from '../services/api-key-manager.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { gatewayService } from '../services/gateway-service.js';
import {
  OpenAIAdapter,
  ChatCompletionRequestSchema,
  ImageGenerationRequestSchema,
} from '../services/openai-adapter.js';
import { redactString } from '../utils/redact.js';
import { accountScheduler } from '../services/scheduler.js';
import { geminiProvider } from '../services/gemini-adapter/index.js';
import { ramMediaCache } from '../services/ram-media-cache.js';
import { db } from '../db/database.js';
import { quotaManager } from '../services/quota-manager.js';
import { GeminiAccount } from '../types.js';

export const openaiRouter = Router();

// Middleware: Authenticate Gateway API key & enforce rate limits
async function authMiddleware(req: Request, res: Response, next: () => void) {
  const authHeader = req.headers.authorization;
  const authResult = apiKeyManager.authenticate(authHeader);

  if (!authResult.authenticated || !authResult.apiKey) {
    return res.status(401).json(OpenAIAdapter.formatError(authResult.error || 'Unauthorized', 'invalid_api_key', 'auth_error'));
  }

  const rateCheck = await rateLimiter.checkAndAcquire(authResult.apiKey);
  if (!rateCheck.allowed) {
    if (rateCheck.retryAfter) {
      res.setHeader('Retry-After', rateCheck.retryAfter.toString());
    }
    return res
      .status(429)
      .json(OpenAIAdapter.formatError(rateCheck.reason || 'Rate limit exceeded', 'rate_limit_exceeded', 'rate_limit_error'));
  }

  // Attach to request
  (req as any).gatewayApiKey = authResult.apiKey;
  next();
}

/**
 * GET /v1/models
 */
openaiRouter.get('/models', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  try {
    const models = gatewayService.listModels(apiKey);
    const caps = gatewayService.getCapabilities(apiKey);
    const response = OpenAIAdapter.toModelListResponse(models, caps);
    return res.json(response);
  } finally {
    await rateLimiter.release(apiKey.id);
  }
});

/**
 * GET /v1/models/capabilities
 */
openaiRouter.get('/models/capabilities', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  try {
    const capabilities = gatewayService.getCapabilities(apiKey);
    return res.json({ object: 'capabilities', data: capabilities });
  } finally {
    await rateLimiter.release(apiKey.id);
  }
});

/**
 * POST /v1/chat/completions
 */
openaiRouter.post('/chat/completions', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const requestId = `req_${crypto.randomBytes(8).toString('hex')}`;
  res.setHeader('x-request-id', requestId);

  // Client disconnect / abort handler: reliably track response connection close
  const abortController = new AbortController();
  const onClose = () => {
    if (!res.writableEnded && !abortController.signal.aborted) {
      abortController.abort();
    }
  };
  res.on('close', onClose);

  try {
    const parseResult = ChatCompletionRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
      return res.status(400).json(OpenAIAdapter.formatError(issues, 'invalid_payload', 'invalid_request_error'));
    }

    const payload = parseResult.data as unknown as import('../types.js').ChatCompletionRequest;

    if (payload.stream) {
      try {
        const stream = gatewayService.handleChatCompletionStream(
          payload,
          apiKey,
          requestId,
          abortController.signal
        );

        const iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next();

        // Setup SSE headers only after successfully acquiring the first chunk
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();

        if (!first.done) {
          res.write(first.value);
          while (true) {
            const { done, value } = await iterator.next();
            if (done || res.writableEnded) break;
            res.write(value);
          }
        }
      } catch (err: any) {
        if (!res.headersSent) {
          // Headers not sent yet, propagate to outer catch block for standard HTTP JSON error response
          throw err;
        }
        const errMsg = redactString(err.message || String(err));
        if (!res.writableEnded) {
          res.write(
            `data: ${JSON.stringify(OpenAIAdapter.formatError(errMsg, 'stream_error', 'upstream_error'))}\n\n`
          );
        }
      } finally {
        if (res.headersSent && !res.writableEnded) {
          res.end();
        }
      }
    } else {
      // Non-streaming completion
      const { response } = await gatewayService.handleChatCompletion(
        payload,
        apiKey,
        requestId,
        abortController.signal
      );
      return res.json(response);
    }
  } catch (err: any) {
    if (res.writableEnded || res.destroyed || abortController.signal.aborted) {
      // Socket closed or aborted by client - do not attempt to write response
      return;
    }

    const errMsg = redactString(err.message || String(err));
    let statusCode = 500;
    let errCode = 'upstream_error';

    if (errMsg.includes('CLIENT_ABORT') || errMsg.includes('AbortError')) {
      statusCode = 499;
      errCode = 'client_abort';
    } else if (errMsg.includes('UPSTREAM_TIMEOUT')) {
      statusCode = 504;
      errCode = 'upstream_timeout';
    } else if (errMsg.includes('CONVERSATION_ACCOUNT_UNAVAILABLE')) {
      statusCode = 503;
      errCode = 'conversation_account_unavailable';
    } else if (errMsg.includes('NO_HEALTHY_ACCOUNTS')) {
      statusCode = 503;
      errCode = 'no_healthy_accounts';
    } else if (errMsg.includes('MODEL_NOT_ALLOWED')) {
      statusCode = 403;
      errCode = 'model_not_available';
    } else if (errMsg.includes('FILE_NOT_FOUND_OR_EXPIRED')) {
      statusCode = 400;
      errCode = 'file_not_found_or_expired';
    } else if (errMsg.includes('FILE_ACCOUNT_MISMATCH')) {
      statusCode = 400;
      errCode = 'file_account_mismatch';
    } else if (errMsg.includes('INVALID_REQUEST')) {
      statusCode = 400;
      errCode = 'invalid_request_error';
    } else if (errMsg.includes('SESSION_EXPIRED')) {
      statusCode = 502;
      errCode = 'upstream_auth_expired';
    } else if (errMsg.includes('QUOTA_EXHAUSTED')) {
      statusCode = 429;
      errCode = 'upstream_quota_exhausted';
    }

    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      return res.status(statusCode).json(OpenAIAdapter.formatError(errMsg, errCode, 'gateway_error'));
    }
  } finally {
    res.removeListener('close', onClose);
    await rateLimiter.release(apiKey.id);
  }
});

/**
 * POST /v1/images/generations
 */
openaiRouter.post('/images/generations', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const requestId = `req_${crypto.randomBytes(8).toString('hex')}`;
  res.setHeader('x-request-id', requestId);

  try {
    const parseResult = ImageGenerationRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
      return res.status(400).json(OpenAIAdapter.formatError(issues, 'invalid_payload', 'invalid_request_error'));
    }

    const response = await gatewayService.handleImageGeneration(parseResult.data, apiKey, requestId);
    return res.json(response);
  } catch (err: any) {
    const errMsg = redactString(err.message || String(err));
    let statusCode = 500;
    let errCode = 'image_generation_failed';

    if (errMsg.includes('UPSTREAM_TIMEOUT')) {
      statusCode = 504;
      errCode = 'upstream_timeout';
    } else if (errMsg.includes('MODEL_NOT_ALLOWED')) {
      statusCode = 403;
      errCode = 'model_not_available';
    } else if (errMsg.includes('NO_HEALTHY_ACCOUNTS')) {
      statusCode = 503;
      errCode = 'no_healthy_accounts';
    } else if (errMsg.includes('SESSION_EXPIRED')) {
      statusCode = 502;
      errCode = 'upstream_auth_expired';
    } else if (errMsg.includes('QUOTA_EXHAUSTED')) {
      statusCode = 429;
      errCode = 'upstream_quota_exhausted';
    }

    return res.status(statusCode).json(OpenAIAdapter.formatError(errMsg, errCode, 'gateway_error'));
  } finally {
    await rateLimiter.release(apiKey.id);
  }
});

/**
 * GET /v1/media/:id (RAM Media Proxy with TTL)
 */
openaiRouter.get('/media/:id', async (req: Request, res: Response) => {
  const item = ramMediaCache.getMedia(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Media artifact not found or expired' });
  }
  res.setHeader('Content-Type', item.mimeType || 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=7200');
  return res.send(item.buffer);
});

/**
 * POST /v1/files (Upload file upstream & store affinity in RAM)
 */
openaiRouter.post('/files', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const { name, data, mime_type } = req.body || {};
  if (!data) {
    await rateLimiter.release(apiKey.id);
    return res.status(400).json(OpenAIAdapter.formatError('File data (base64 string) is required', 'missing_file_data'));
  }

  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > 20 * 1024 * 1024) {
    await rateLimiter.release(apiKey.id);
    return res.status(400).json(OpenAIAdapter.formatError('File size exceeds 20MB limit', 'file_too_large'));
  }

  const targetAccount = accountScheduler.selectAnyActiveAccount();
  if (!targetAccount) {
    await rateLimiter.release(apiKey.id);
    return res.status(503).json(OpenAIAdapter.formatError('No active Gemini account for upload', 'no_healthy_accounts'));
  }

  try {
    const uploaded = await geminiProvider.uploadFile(
      targetAccount,
      name || 'attachment.bin',
      mime_type || 'application/octet-stream',
      buffer
    );

    const now = new Date();
    // Record affinity in RAM with TTL (24h)
    accountScheduler.setUploadedFileAffinity(uploaded.id, targetAccount.id);

    return res.json({
      id: uploaded.id,
      name: uploaded.name,
      size: buffer.length,
      mime_type: mime_type || 'application/octet-stream',
      created_at: now.toISOString(),
    });
  } catch (err: any) {
    return res.status(500).json(OpenAIAdapter.formatError(err.message || 'File upload failed', 'upload_failed'));
  } finally {
    await rateLimiter.release(apiKey.id);
  }
});

/**
 * UPSTREAM CONVERSATION RELAY (Gemini Web is Single Source of Truth)
 */

// GET /v1/conversations/upstream-recent
openaiRouter.get('/conversations/upstream-recent', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const explicitAccountId = req.query.account_id as string | undefined;

  let targetAccount: GeminiAccount | null = null;
  if (explicitAccountId) {
    const acc = db.getAccountById(explicitAccountId);
    if (acc && acc.status === 'ACTIVE' && !quotaManager.isCoolingDown(acc)) {
      targetAccount = acc;
    }
  }
  if (!targetAccount) {
    targetAccount = accountScheduler.selectAnyActiveAccount();
  }

  if (!targetAccount) {
    await rateLimiter.release(apiKey.id);
    return res.status(503).json(OpenAIAdapter.formatError('No active Gemini account found', 'no_healthy_accounts'));
  }

  try {
    const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit || '10'), 10)));
    const conversations = await geminiProvider.fetchRecentConversations(targetAccount, limit);

    // Register RAM affinity for discovered conversations
    for (const c of conversations) {
      if (c.id) {
        accountScheduler.setConversationAffinity(c.id, targetAccount.id);
      }
    }

    return res.json({
      object: 'list',
      account_id: targetAccount.id,
      data: conversations.map((c) => ({
        ...c,
        account_id: targetAccount.id,
      })),
    });
  } catch (err: any) {
    const errMsg = redactString(err.message || 'Failed to fetch upstream conversations');
    const statusCode = errMsg.includes('UPSTREAM_TIMEOUT') ? 504 : 500;
    return res.status(statusCode).json(OpenAIAdapter.formatError(errMsg, errMsg.includes('UPSTREAM_TIMEOUT') ? 'upstream_timeout' : 'upstream_error'));
  } finally {
    await rateLimiter.release(apiKey.id);
  }
});

// GET /v1/conversations/upstream/:cid/turns
openaiRouter.get('/conversations/upstream/:cid/turns', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const cid = req.params.cid;
  const explicitAccountId = req.query.account_id as string | undefined;

  let targetAccount: GeminiAccount | null = null;
  const affinityAccountId = accountScheduler.getConversationAffinity(cid);

  if (affinityAccountId) {
    // Priority 1: RAM conversation affinity
    const acc = db.getAccountById(affinityAccountId);
    if (!acc || acc.status !== 'ACTIVE' || quotaManager.isCoolingDown(acc)) {
      await rateLimiter.release(apiKey.id);
      return res.status(503).json(
        OpenAIAdapter.formatError(
          `CONVERSATION_ACCOUNT_UNAVAILABLE: The Gemini account (${affinityAccountId}) associated with conversation "${cid}" is inactive or unavailable`,
          'conversation_account_unavailable',
          'upstream_error'
        )
      );
    }
    targetAccount = acc;
  } else if (explicitAccountId) {
    // Priority 2: Explicit account_id
    const acc = db.getAccountById(explicitAccountId);
    if (!acc || acc.status !== 'ACTIVE' || quotaManager.isCoolingDown(acc)) {
      await rateLimiter.release(apiKey.id);
      return res.status(503).json(
        OpenAIAdapter.formatError(
          `CONVERSATION_ACCOUNT_UNAVAILABLE: The Gemini account (${explicitAccountId}) specified for conversation "${cid}" is inactive or unavailable`,
          'conversation_account_unavailable',
          'upstream_error'
        )
      );
    }
    targetAccount = acc;
  } else {
    // Priority 3: Fallback active account selection
    targetAccount = accountScheduler.selectAnyActiveAccount();
  }

  if (!targetAccount) {
    await rateLimiter.release(apiKey.id);
    return res.status(503).json(OpenAIAdapter.formatError('No active Gemini account found', 'no_healthy_accounts'));
  }

  try {
    const data = await geminiProvider.fetchConversationHistory(targetAccount, cid);
    // Refresh/set RAM affinity for this conversation
    accountScheduler.setConversationAffinity(cid, targetAccount.id);

    return res.json({
      conversation_id: cid,
      account_id: targetAccount.id,
      turns: data.turns,
      last_rid: data.lastRid,
      last_rcid: data.lastRcid,
    });
  } catch (err: any) {
    const errMsg = redactString(err.message || 'Failed to fetch upstream conversation turns');
    const statusCode = errMsg.includes('UPSTREAM_TIMEOUT') ? 504 : errMsg.includes('CONVERSATION_ACCOUNT_UNAVAILABLE') ? 503 : 500;
    return res.status(statusCode).json(OpenAIAdapter.formatError(errMsg, errMsg.includes('UPSTREAM_TIMEOUT') ? 'upstream_timeout' : 'upstream_error'));
  } finally {
    await rateLimiter.release(apiKey.id);
  }
});

// Deprecated local conversation routes (Stateless Gateway)
openaiRouter.all(['/conversations', '/conversations/*'], authMiddleware, async (req: Request, res: Response) => {
  await rateLimiter.release((req as any).gatewayApiKey.id);
  return res.status(410).json(
    OpenAIAdapter.formatError(
      'Local conversation persistence has been removed. Gateway is stateless; use upstream Gemini endpoints (/v1/conversations/upstream-recent, /v1/conversations/upstream/:cid/turns) and pass conversation_id / upstream metadata to /v1/chat/completions.',
      'deprecated_endpoint',
      'invalid_request_error'
    )
  );
});
