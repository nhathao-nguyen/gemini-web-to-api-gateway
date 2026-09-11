import crypto from 'crypto';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ApiKey,
  GeminiAccount,
} from '../types.js';
import { accountScheduler } from './scheduler.js';
import { quotaManager } from './quota-manager.js';
import { apiKeyManager } from './api-key-manager.js';
import { geminiProvider } from './gemini-adapter/index.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { usageService } from './usage-service.js';
import { redactString } from '../utils/redact.js';

export class GatewayService {
  /**
   * List available models for this authenticated API key
   */
  public listModels(apiKey: ApiKey): string[] {
    const available = accountScheduler.getAvailableModels();
    return available.filter((m) => apiKeyManager.isModelAllowed(apiKey, m));
  }

  /**
   * Execute non-streaming OpenAI chat completion with intelligent failover
   */
  public async handleChatCompletion(
    request: ChatCompletionRequest,
    apiKey: ApiKey,
    requestId: string,
    signal?: AbortSignal
  ): Promise<{ response: ChatCompletionResponse; accountUsed: GeminiAccount }> {
    const startTime = Date.now();

    // 1. Model permission check
    if (!apiKeyManager.isModelAllowed(apiKey, request.model)) {
      throw new Error(`MODEL_NOT_ALLOWED: Your API key is not permitted to access model "${request.model}"`);
    }

    const excludedIds: string[] = [];
    const maxAttempts = 2;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let targetAccount: GeminiAccount | null = null;

      // Check sticky session on first attempt
      if (attempt === 1 && request.conversation_id) {
        targetAccount = accountScheduler.getStickyAccount(request.conversation_id, request.model);
      }

      // If no sticky account or sticky not eligible, run weighted score scheduler
      if (!targetAccount) {
        targetAccount = accountScheduler.selectAccount(request.model, excludedIds);
      }

      if (!targetAccount) {
        if (attempt === 1) {
          throw new Error(`NO_HEALTHY_ACCOUNTS: No active Gemini account available for model "${request.model}"`);
        }
        break; // No other accounts available to failover
      }

      accountScheduler.incrementActive(targetAccount.id);

      try {
        const result = await geminiProvider.ChatCompletion(targetAccount, request, signal);

        // Record health success
        quotaManager.recordSuccess(targetAccount.id);

        // Save sticky conversation if conversation_id was provided or generated
        const convId = request.conversation_id || result.conversation_id;
        if (convId) {
          accountScheduler.setStickySession(convId, targetAccount.id);
        }

        const openAiResponse = OpenAIAdapter.toChatCompletionResponse(request.model, result);

        // Usage telemetry
        usageService.logRequest({
          request_id: requestId,
          api_key_id: apiKey.id,
          account_id: targetAccount.id,
          model: request.model,
          status: 200,
          latency_ms: Date.now() - startTime,
          error_code: null,
          created_at: new Date().toISOString(),
        });

        return { response: openAiResponse, accountUsed: targetAccount };
      } catch (err: any) {
        lastError = err;
        quotaManager.recordError(targetAccount.id, err);
        excludedIds.push(targetAccount.id);

        console.warn(
          `[Gateway] Attempt ${attempt}/${maxAttempts} failed on account "${targetAccount.name}": ${redactString(
            err.message || String(err)
          )}`
        );
      } finally {
        accountScheduler.decrementActive(targetAccount.id);
      }
    }

    const latency = Date.now() - startTime;
    usageService.logRequest({
      request_id: requestId,
      api_key_id: apiKey.id,
      account_id: excludedIds[0] || 'unknown',
      model: request.model,
      status: 502,
      latency_ms: latency,
      error_code: 'UPSTREAM_FAILOVER_EXHAUSTED',
      created_at: new Date().toISOString(),
    });

    throw lastError || new Error('UPSTREAM_ERROR: All eligible accounts failed to process request');
  }

  /**
   * Execute streaming OpenAI chat completion
   */
  public async *handleChatCompletionStream(
    request: ChatCompletionRequest,
    apiKey: ApiKey,
    requestId: string,
    signal?: AbortSignal
  ): AsyncIterable<string> {
    const startTime = Date.now();

    if (!apiKeyManager.isModelAllowed(apiKey, request.model)) {
      throw new Error(`MODEL_NOT_ALLOWED: Your API key is not permitted to access model "${request.model}"`);
    }

    let targetAccount: GeminiAccount | null = null;
    if (request.conversation_id) {
      targetAccount = accountScheduler.getStickyAccount(request.conversation_id, request.model);
    }
    if (!targetAccount) {
      targetAccount = accountScheduler.selectAccount(request.model);
    }

    if (!targetAccount) {
      throw new Error(`NO_HEALTHY_ACCOUNTS: No active Gemini account available for model "${request.model}"`);
    }

    accountScheduler.incrementActive(targetAccount.id);
    const chunkId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    let fullText = '';
    let lastConvId: string | undefined;

    try {
      // First chunk: emit role
      const initialChunk: any = {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      };
      yield `data: ${JSON.stringify(initialChunk)}\n\n`;

      const stream = geminiProvider.ChatCompletionStream(targetAccount, request, signal);

      for await (const chunk of stream) {
        if (chunk.conversation_id) lastConvId = chunk.conversation_id;

        if (chunk.text_delta) {
          fullText += chunk.text_delta;
          yield OpenAIAdapter.toChatCompletionChunk(chunkId, request.model, chunk.text_delta, null);
        }

        if (chunk.is_done) {
          yield OpenAIAdapter.toChatCompletionChunk(chunkId, request.model, '', 'stop');
          break;
        }
      }

      // Final DONE message
      yield 'data: [DONE]\n\n';

      quotaManager.recordSuccess(targetAccount.id);
      const finalConv = request.conversation_id || lastConvId;
      if (finalConv) {
        accountScheduler.setStickySession(finalConv, targetAccount.id);
      }

      usageService.logRequest({
        request_id: requestId,
        api_key_id: apiKey.id,
        account_id: targetAccount.id,
        model: request.model,
        status: 200,
        latency_ms: Date.now() - startTime,
        error_code: null,
        created_at: new Date().toISOString(),
      });
    } catch (err: any) {
      quotaManager.recordError(targetAccount.id, err);
      usageService.logRequest({
        request_id: requestId,
        api_key_id: apiKey.id,
        account_id: targetAccount.id,
        model: request.model,
        status: 500,
        latency_ms: Date.now() - startTime,
        error_code: 'STREAM_ERROR',
        created_at: new Date().toISOString(),
      });
      throw err;
    } finally {
      accountScheduler.decrementActive(targetAccount.id);
    }
  }
}

export const gatewayService = new GatewayService();
