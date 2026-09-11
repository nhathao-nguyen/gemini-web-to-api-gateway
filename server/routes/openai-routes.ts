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
import { db } from '../db/database.js';
import { accountScheduler } from '../services/scheduler.js';
import { geminiProvider } from '../services/gemini-adapter/index.js';

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
 * POST /v1/chat/completions
 */
openaiRouter.post('/chat/completions', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const requestId = `req_${crypto.randomBytes(8).toString('hex')}`;
  res.setHeader('x-request-id', requestId);

  // Setup abort controller on client disconnect
  const abortController = new AbortController();
  const onDisconnect = () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  };
  req.on('close', onDisconnect);
  res.on('close', onDisconnect);

  try {
    const parseResult = ChatCompletionRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
      return res.status(400).json(OpenAIAdapter.formatError(issues, 'invalid_payload', 'invalid_request_error'));
    }

    const payload = parseResult.data as unknown as import('../types.js').ChatCompletionRequest;

    // Validate conversation ownership if conversation_id is provided
    if (payload.conversation_id) {
      const conv = db.getConversation(payload.conversation_id);
      if (!conv || conv.api_key_id !== apiKey.id) {
        return res
          .status(404)
          .json(OpenAIAdapter.formatError('Conversation not found', 'conversation_not_found', 'invalid_request_error'));
      }
    }

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
    const errMsg = redactString(err.message || String(err));
    let statusCode = 500;
    let errCode = 'upstream_error';

    if (errMsg.includes('MODEL_NOT_ALLOWED')) {
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
    return res.status(500).json(OpenAIAdapter.formatError(errMsg, 'image_generation_failed', 'gateway_error'));
  } finally {
    await rateLimiter.release(apiKey.id);
  }
});

/**
 * GET /v1/media/:id (Media Proxy)
 */
openaiRouter.get('/media/:id', async (req: Request, res: Response) => {
  const item = db.getMediaCache(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Media artifact not found' });
  }
  const buffer = Buffer.from(item.data_b64, 'base64');
  res.setHeader('Content-Type', item.mime_type || 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.send(buffer);
});

/**
 * POST /v1/files (Upload file upstream)
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
    return res.json({
      id: uploaded.id,
      name: uploaded.name,
      size: buffer.length,
      mime_type: mime_type || 'application/octet-stream',
      created_at: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(500).json(OpenAIAdapter.formatError(err.message || 'File upload failed', 'upload_failed'));
  } finally {
    await rateLimiter.release(apiKey.id);
  }
});

/**
 * CONVERSATION MANAGEMENT
 */

// POST /v1/conversations
openaiRouter.post('/conversations', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const id = `conv_${crypto.randomBytes(12).toString('hex')}`;
  const title = (req.body?.title || 'New Conversation').trim().slice(0, 100);
  const defaultModel = accountScheduler.getAvailableModels()[0] || 'gemini-2.5-flash';
  const model = req.body?.model || defaultModel;
  const now = new Date().toISOString();

  const conv = {
    id,
    title,
    model,
    account_id: '',
    api_key_id: apiKey.id,
    created_at: now,
    updated_at: now,
  };

  db.createConversation(conv);
  await rateLimiter.release(apiKey.id);
  return res.status(201).json(conv);
});

// GET /v1/conversations
openaiRouter.get('/conversations', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const convs = db.listConversations(apiKey.id);
  await rateLimiter.release(apiKey.id);
  return res.json({ object: 'list', data: convs });
});

// GET /v1/conversations/upstream-recent (Registered before /:id to prevent route shadowing)
openaiRouter.get('/conversations/upstream-recent', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const targetAccount = accountScheduler.selectAnyActiveAccount();

  if (!targetAccount) {
    await rateLimiter.release(apiKey.id);
    return res.status(503).json(OpenAIAdapter.formatError('No active Gemini account found', 'no_healthy_accounts'));
  }

  try {
    const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit || '10'), 10)));
    const conversations = await geminiProvider.fetchRecentConversations(targetAccount, limit);
    return res.json({
      object: 'list',
      data: conversations,
    });
  } catch (err: any) {
    return res.status(500).json(OpenAIAdapter.formatError(err.message || 'Failed to fetch upstream conversations', 'upstream_error'));
  } finally {
    await rateLimiter.release(apiKey.id);
  }
});

// GET /v1/conversations/upstream/:cid/turns (Registered before /:id)
openaiRouter.get('/conversations/upstream/:cid/turns', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const targetAccount = accountScheduler.selectAnyActiveAccount();

  if (!targetAccount) {
    await rateLimiter.release(apiKey.id);
    return res.status(503).json(OpenAIAdapter.formatError('No active Gemini account found', 'no_healthy_accounts'));
  }

  try {
    const data = await geminiProvider.fetchConversationHistory(targetAccount, req.params.cid);
    return res.json({
      conversation_id: req.params.cid,
      turns: data.turns,
      last_rid: data.lastRid,
      last_rcid: data.lastRcid,
    });
  } catch (err: any) {
    return res.status(500).json(OpenAIAdapter.formatError(err.message || 'Failed to fetch upstream conversation turns', 'upstream_error'));
  } finally {
    await rateLimiter.release(apiKey.id);
  }
});

// GET /v1/conversations/:id
openaiRouter.get('/conversations/:id', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const conv = db.getConversation(req.params.id);
  await rateLimiter.release(apiKey.id);

  if (!conv || conv.api_key_id !== apiKey.id) {
    return res.status(404).json(OpenAIAdapter.formatError('Conversation not found', 'conversation_not_found'));
  }

  const messages = db.listMessages(conv.id);
  return res.json({ ...conv, messages });
});

// DELETE /v1/conversations/:id
openaiRouter.delete('/conversations/:id', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const conv = db.getConversation(req.params.id);
  await rateLimiter.release(apiKey.id);

  if (!conv || conv.api_key_id !== apiKey.id) {
    return res.status(404).json(OpenAIAdapter.formatError('Conversation not found', 'conversation_not_found'));
  }

  db.deleteConversation(conv.id);
  return res.json({ id: conv.id, deleted: true });
});

// POST /v1/conversations/:id/messages
openaiRouter.post('/conversations/:id/messages', authMiddleware, async (req: Request, res: Response) => {
  const apiKey = (req as any).gatewayApiKey;
  const conv = db.getConversation(req.params.id);
  if (!conv || conv.api_key_id !== apiKey.id) {
    await rateLimiter.release(apiKey.id);
    return res.status(404).json(OpenAIAdapter.formatError('Conversation not found', 'conversation_not_found'));
  }

  const requestId = `req_${crypto.randomBytes(8).toString('hex')}`;
  res.setHeader('x-request-id', requestId);

  try {
    const content = req.body?.content || '';
    if (!content) {
      return res.status(400).json(OpenAIAdapter.formatError('Message content is required', 'missing_content'));
    }

    const history = db.listMessages(conv.id);
    const messages = history.map((m) => ({
      role: m.role as any,
      content: m.content,
    }));
    messages.push({ role: 'user', content });

    const payload: any = {
      model: req.body?.model || conv.model,
      messages,
      conversation_id: conv.id,
      upstream_cid: conv.upstream_cid,
      upstream_rid: conv.upstream_rid,
      upstream_rcid: conv.upstream_rcid,
      stream: false,
    };

    const { response } = await gatewayService.handleChatCompletion(payload, apiKey, requestId);
    return res.json(response);
  } catch (err: any) {
    return res.status(500).json(OpenAIAdapter.formatError(err.message || 'Failed to send message', 'conversation_error'));
  } finally {
    await rateLimiter.release(apiKey.id);
  }
});


