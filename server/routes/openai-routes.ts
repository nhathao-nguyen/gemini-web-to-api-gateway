import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { apiKeyManager } from '../services/api-key-manager.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { gatewayService } from '../services/gateway-service.js';
import { OpenAIAdapter, ChatCompletionRequestSchema } from '../services/openai-adapter.js';
import { redactString } from '../utils/redact.js';

export const openaiRouter = Router();

// Middleware: Authenticate Gateway API key & enforce rate limits
async function authMiddleware(req: Request, res: Response, next: () => void) {
  const authHeader = req.headers.authorization;
  const authResult = apiKeyManager.authenticate(authHeader);

  if (!authResult.authenticated || !authResult.apiKey) {
    return res.status(401).json(OpenAIAdapter.formatError(authResult.error || 'Unauthorized', 'invalid_api_key', 'auth_error'));
  }

  const rateCheck = rateLimiter.checkAndAcquire(authResult.apiKey);
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
    const response = OpenAIAdapter.toModelListResponse(models);
    return res.json(response);
  } finally {
    rateLimiter.release(apiKey.id);
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
  req.on('aborted', () => {
    abortController.abort();
  });

  try {
    const parseResult = ChatCompletionRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
      return res.status(400).json(OpenAIAdapter.formatError(issues, 'invalid_payload', 'invalid_request_error'));
    }

    const payload = parseResult.data as unknown as import('../types.js').ChatCompletionRequest;

    if (payload.stream) {
      // Setup SSE headers
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      try {
        const stream = gatewayService.handleChatCompletionStream(
          payload,
          apiKey,
          requestId,
          abortController.signal
        );

        for await (const chunk of stream) {
          if (res.writableEnded) break;
          res.write(chunk);
        }
      } catch (err: any) {
        const errMsg = redactString(err.message || String(err));
        if (!res.writableEnded) {
          res.write(
            `data: ${JSON.stringify(OpenAIAdapter.formatError(errMsg, 'stream_error', 'upstream_error'))}\n\n`
          );
        }
      } finally {
        if (!res.writableEnded) {
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
    rateLimiter.release(apiKey.id);
  }
});
