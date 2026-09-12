import crypto from 'crypto';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ApiKey,
  GeminiAccount,
  ImageGenerationRequest,
  ModelCapabilities,
} from '../types.js';
import { accountScheduler } from './scheduler.js';
import { quotaManager } from './quota-manager.js';
import { apiKeyManager } from './api-key-manager.js';
import { geminiProvider } from './gemini-adapter/index.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { usageService } from './usage-service.js';
import { redactString } from '../utils/redact.js';
import { config } from '../config.js';
import { db } from '../db/database.js';
import { ramMediaCache } from './ram-media-cache.js';

export class GatewayService {
  /**
   * List available models for this authenticated API key
   */
  public listModels(apiKey: ApiKey): string[] {
    const available = accountScheduler.getAvailableModels();
    return available.filter((m) => apiKeyManager.isModelAllowed(apiKey, m));
  }

  /**
   * Get capability map for all accessible models
   */
  public getCapabilities(apiKey: ApiKey): Record<string, ModelCapabilities> {
    const models = this.listModels(apiKey);
    const result: Record<string, ModelCapabilities> = {};
    for (const model of models) {
      result[model] = geminiProvider.getModelCapabilities(model);
    }
    return result;
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

    // 0. Parameter validation: tools / tool_choice
    if (request.tools && request.tools.length > 0) {
      throw new Error('INVALID_REQUEST: Tools and function calling are not supported by the Gemini Web adapter');
    }
    if (request.tool_choice) {
      throw new Error('INVALID_REQUEST: Tool choice is not supported by the Gemini Web adapter');
    }

    // 1. Model permission check
    if (!apiKeyManager.isModelAllowed(apiKey, request.model)) {
      throw new Error(`MODEL_NOT_ALLOWED: Your API key is not permitted to access model "${request.model}"`);
    }

    // 2. Check uploaded file account affinity (RAM only)
    let fileAffinityAccountId: string | null = null;
    if (request.uploaded_files && request.uploaded_files.length > 0) {
      fileAffinityAccountId = accountScheduler.checkUploadedFilesAffinity(request.uploaded_files);
    }

    // 3. Check Gemini conversation account affinity (RAM only)
    const conversationIdParam = (request.upstream_cid || request.conversation_id || '').trim();
    const convAffinityAccountId = conversationIdParam
      ? accountScheduler.getConversationAffinity(conversationIdParam)
      : null;

    // Normalize request conversation fields
    if (conversationIdParam.startsWith('c_') && !request.upstream_cid) {
      request.upstream_cid = conversationIdParam;
    }

    const excludedIds: string[] = [];
    const maxAttempts = config.maxUpstreamAttempts || 2;
    const operationDeadline = Date.now() + (config.requestTimeout || 60000);
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let targetAccount: GeminiAccount | null = null;
      let isHardAffinity = false;

      // Priority 1: File upload account affinity takes absolute precedence (hard affinity)
      if (fileAffinityAccountId) {
        isHardAffinity = true;
        const acc = db.getAccountById(fileAffinityAccountId);
        if (!acc || acc.status !== 'ACTIVE' || quotaManager.isCoolingDown(acc)) {
          throw new Error(
            `NO_HEALTHY_ACCOUNTS: The Gemini account (${fileAffinityAccountId}) that owns the uploaded file is inactive or unavailable`
          );
        }
        targetAccount = acc;
      } else if (convAffinityAccountId) {
        // Priority 2: Gemini conversation affinity (hard affinity)
        isHardAffinity = true;
        const acc = db.getAccountById(convAffinityAccountId);
        if (!acc || acc.status !== 'ACTIVE' || quotaManager.isCoolingDown(acc)) {
          throw new Error(
            `CONVERSATION_ACCOUNT_UNAVAILABLE: The Gemini account (${convAffinityAccountId}) associated with conversation "${conversationIdParam}" is inactive or unavailable`
          );
        }
        targetAccount = acc;
      } else if (attempt === 1 && conversationIdParam) {
        // Priority 3: Soft sticky session routing
        targetAccount = accountScheduler.getStickyAccount(conversationIdParam, request.model);
      }

      // Priority 4: Weighted scheduler selection
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
        const result = await geminiProvider.ChatCompletion(targetAccount, request, signal, operationDeadline);

        // Record health success
        quotaManager.recordSuccess(targetAccount.id);

        // Cache generated media in RAM if any
        if (result.images && result.images.length > 0) {
          for (const img of result.images) {
            try {
              const downloaded = await geminiProvider.downloadGeneratedImage(targetAccount, img.url, 2048, signal, operationDeadline);
              const b64 = downloaded.data.toString('base64');
              img.b64_json = b64;
              const mediaId = `media_${crypto.randomBytes(8).toString('hex')}`;
              ramMediaCache.saveMedia(mediaId, downloaded.data, downloaded.mimeType);
              img.url = `/v1/media/${mediaId}`;
            } catch (dlErr) {
              console.warn('[Gateway] Media cache download error:', dlErr);
            }
          }
        }

        // Save conversation affinity in RAM
        const finalConvId = result.conversation_id || request.upstream_cid || request.conversation_id;
        if (finalConvId) {
          accountScheduler.setConversationAffinity(finalConvId, targetAccount.id);
          accountScheduler.setStickySession(finalConvId, targetAccount.id);
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
        const errMsg = err.message || String(err);

        // 1. Client cancellation / abort: do NOT failover, do NOT penalize account
        if (signal?.aborted || errMsg.includes('CLIENT_ABORT') || errMsg.includes('AbortError')) {
          throw err;
        }

        // 2. Request validation / authorization error: do NOT failover
        if (
          errMsg.includes('MODEL_NOT_ALLOWED') ||
          errMsg.includes('INVALID_REQUEST') ||
          errMsg.includes('FILE_ACCOUNT_MISMATCH') ||
          errMsg.includes('FILE_NOT_FOUND_OR_EXPIRED') ||
          errMsg.includes('CONVERSATION_ACCOUNT_UNAVAILABLE')
        ) {
          throw err;
        }

        // 3. Hard affinity (uploaded file or native conversation bound to a specific account) cannot failover
        if (isHardAffinity) {
          quotaManager.recordError(targetAccount.id, err);
          throw err;
        }

        quotaManager.recordError(targetAccount.id, err);
        excludedIds.push(targetAccount.id);

        console.warn(
          `[Gateway] Attempt ${attempt}/${maxAttempts} failed on account "${targetAccount.name}": ${redactString(
            errMsg
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
   * Execute dedicated image generation via Gemini Web session
   */
  public async handleImageGeneration(
    request: ImageGenerationRequest,
    apiKey: ApiKey,
    requestId: string
  ): Promise<{ created: number; data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> }> {
    const startTime = Date.now();

    let modelToUse: string;
    if (request.model) {
      if (!apiKeyManager.isModelAllowed(apiKey, request.model)) {
        throw new Error(`MODEL_NOT_ALLOWED: Your API key is not permitted to access model "${request.model}"`);
      }
      modelToUse = request.model;
    } else {
      const availableModels = accountScheduler.getAvailableModels();
      const permittedModels = availableModels.filter((m) => apiKeyManager.isModelAllowed(apiKey, m));
      if (permittedModels.length === 0) {
        throw new Error(`MODEL_NOT_ALLOWED: No available account models permitted for this API key`);
      }
      modelToUse = permittedModels[0];
    }

    let targetAccount = accountScheduler.selectAccount(modelToUse);
    if (!targetAccount) {
      // If primary selection had no healthy account, only fallback to models permitted for this API key
      const availableModels = accountScheduler.getAvailableModels();
      const permittedModels = availableModels.filter((m) => apiKeyManager.isModelAllowed(apiKey, m));
      for (const fallbackModel of permittedModels) {
        targetAccount = accountScheduler.selectAccount(fallbackModel);
        if (targetAccount) {
          modelToUse = fallbackModel;
          break;
        }
      }
    }

    if (!targetAccount) {
      throw new Error(`NO_HEALTHY_ACCOUNTS: No active Gemini account available for image generation`);
    }

    accountScheduler.incrementActive(targetAccount.id);

    try {
      const promptText = `Generate a high quality, clear image: ${request.prompt}`;
      const chatReq: ChatCompletionRequest = {
        model: modelToUse,
        messages: [{ role: 'user', content: promptText }],
      };

      const result = await geminiProvider.ChatCompletion(targetAccount, chatReq);
      quotaManager.recordSuccess(targetAccount.id);

      if (!result.images || result.images.length === 0) {
        throw new Error(
          `image_generation_failed: Upstream returned response without media artifact. Text: "${result.text.slice(0, 100)}"`
        );
      }

      const generatedImg = result.images[0];
      let b64: string | undefined;
      let mediaId: string | undefined;
      const imgDeadline = Date.now() + (config.requestTimeout || 60000);

      try {
        const downloaded = await geminiProvider.downloadGeneratedImage(targetAccount, generatedImg.url, 2048, undefined, imgDeadline);
        b64 = downloaded.data.toString('base64');
        mediaId = `media_${crypto.randomBytes(8).toString('hex')}`;

        ramMediaCache.saveMedia(mediaId, downloaded.data, downloaded.mimeType);
      } catch (dlErr: any) {
        console.warn(
          `[handleImageGeneration] Server-side binary download unavailable (${dlErr.message}), returning upstream media reference`
        );
      }

      usageService.logRequest({
        request_id: requestId,
        api_key_id: apiKey.id,
        account_id: targetAccount.id,
        model: modelToUse,
        status: 200,
        latency_ms: Date.now() - startTime,
        error_code: null,
        created_at: new Date().toISOString(),
      });

      const responseItem: any = { revised_prompt: request.prompt };
      if (request.response_format === 'url') {
        responseItem.url = mediaId ? `/v1/media/${mediaId}` : generatedImg.url;
      } else {
        if (b64) {
          responseItem.b64_json = b64;
        } else {
          responseItem.url = generatedImg.url;
        }
      }

      return {
        created: Math.floor(Date.now() / 1000),
        data: [responseItem],
      };
    } catch (err: any) {
      quotaManager.recordError(targetAccount.id, err);
      usageService.logRequest({
        request_id: requestId,
        api_key_id: apiKey.id,
        account_id: targetAccount.id,
        model: modelToUse,
        status: 500,
        latency_ms: Date.now() - startTime,
        error_code: 'IMAGE_GENERATION_FAILED',
        created_at: new Date().toISOString(),
      });
      throw err;
    } finally {
      accountScheduler.decrementActive(targetAccount.id);
    }
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

    // 0. Parameter validation: tools / tool_choice
    if (request.tools && request.tools.length > 0) {
      throw new Error('INVALID_REQUEST: Tools and function calling are not supported by the Gemini Web adapter');
    }
    if (request.tool_choice) {
      throw new Error('INVALID_REQUEST: Tool choice is not supported by the Gemini Web adapter');
    }

    // 1. Model permission check
    if (!apiKeyManager.isModelAllowed(apiKey, request.model)) {
      throw new Error(`MODEL_NOT_ALLOWED: Your API key is not permitted to access model "${request.model}"`);
    }

    // 2. Check uploaded file account affinity (RAM only)
    let fileAffinityAccountId: string | null = null;
    if (request.uploaded_files && request.uploaded_files.length > 0) {
      fileAffinityAccountId = accountScheduler.checkUploadedFilesAffinity(request.uploaded_files);
    }

    // 3. Check Gemini conversation account affinity (RAM only)
    const conversationIdParam = (request.upstream_cid || request.conversation_id || '').trim();
    const convAffinityAccountId = conversationIdParam
      ? accountScheduler.getConversationAffinity(conversationIdParam)
      : null;

    if (conversationIdParam.startsWith('c_') && !request.upstream_cid) {
      request.upstream_cid = conversationIdParam;
    }

    const excludedIds: string[] = [];
    const maxAttempts = config.maxUpstreamAttempts || 2;
    const operationDeadline = Date.now() + (config.requestTimeout || 60000);
    let targetAccount: GeminiAccount | null = null;
    let isHardAffinity = false;
    let stream: AsyncIterable<any> | null = null;
    let streamIterator: AsyncIterator<any> | null = null;
    let firstStreamResult: IteratorResult<any> | null = null;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      targetAccount = null;
      isHardAffinity = false;

      // Priority 1: File upload account affinity takes absolute precedence (hard affinity)
      if (fileAffinityAccountId) {
        isHardAffinity = true;
        const acc = db.getAccountById(fileAffinityAccountId);
        if (!acc || acc.status !== 'ACTIVE' || quotaManager.isCoolingDown(acc)) {
          throw new Error(
            `NO_HEALTHY_ACCOUNTS: The Gemini account (${fileAffinityAccountId}) that owns the uploaded file is inactive or unavailable`
          );
        }
        targetAccount = acc;
      } else if (convAffinityAccountId) {
        // Priority 2: Gemini conversation affinity (hard affinity)
        isHardAffinity = true;
        const acc = db.getAccountById(convAffinityAccountId);
        if (!acc || acc.status !== 'ACTIVE' || quotaManager.isCoolingDown(acc)) {
          throw new Error(
            `CONVERSATION_ACCOUNT_UNAVAILABLE: The Gemini account (${convAffinityAccountId}) associated with conversation "${conversationIdParam}" is inactive or unavailable`
          );
        }
        targetAccount = acc;
      } else if (attempt === 1 && conversationIdParam) {
        // Priority 3: Soft sticky session routing
        targetAccount = accountScheduler.getStickyAccount(conversationIdParam, request.model);
      }

      // Priority 4: Weighted scheduler selection
      if (!targetAccount) {
        targetAccount = accountScheduler.selectAccount(request.model, excludedIds);
      }

      if (!targetAccount) {
        if (attempt === 1) {
          throw new Error(`NO_HEALTHY_ACCOUNTS: No active Gemini account available for model "${request.model}"`);
        }
        break;
      }

      accountScheduler.incrementActive(targetAccount.id);

      try {
        stream = geminiProvider.ChatCompletionStream(targetAccount, request, signal, operationDeadline);
        streamIterator = stream[Symbol.asyncIterator]();
        firstStreamResult = await streamIterator.next();
        break; // Successfully connected and obtained first stream frame
      } catch (connErr: any) {
        lastError = connErr;
        const errMsg = connErr.message || String(connErr);
        accountScheduler.decrementActive(targetAccount.id);

        // 1. Client cancellation / abort: do NOT failover, do NOT penalize account
        if (signal?.aborted || errMsg.includes('CLIENT_ABORT') || errMsg.includes('AbortError')) {
          throw connErr;
        }

        // 2. Request validation / authorization error: do NOT failover
        if (
          errMsg.includes('MODEL_NOT_ALLOWED') ||
          errMsg.includes('INVALID_REQUEST') ||
          errMsg.includes('FILE_ACCOUNT_MISMATCH') ||
          errMsg.includes('FILE_NOT_FOUND_OR_EXPIRED') ||
          errMsg.includes('CONVERSATION_ACCOUNT_UNAVAILABLE')
        ) {
          throw connErr;
        }

        // 3. Hard affinity (uploaded file or conversation) cannot failover to a different account
        if (isHardAffinity) {
          quotaManager.recordError(targetAccount.id, connErr);
          throw connErr;
        }

        quotaManager.recordError(targetAccount.id, connErr);
        excludedIds.push(targetAccount.id);
        console.warn(
          `[Gateway Stream] Attempt ${attempt}/${maxAttempts} failed on account "${targetAccount.name}": ${redactString(
            errMsg
          )}`
        );
        targetAccount = null;
        stream = null;
        streamIterator = null;
        firstStreamResult = null;
      }
    }

    if (!targetAccount || !streamIterator || !firstStreamResult) {
      throw lastError || new Error('UPSTREAM_ERROR: All eligible accounts failed to establish streaming connection');
    }

    const chunkId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    let lastConvId: string | undefined;
    let lastRespId: string | undefined;
    let lastChoiceId: string | undefined;

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

      let currentResult: IteratorResult<any> | null = firstStreamResult;

      while (currentResult && !currentResult.done) {
        const chunk = currentResult.value;
        if (chunk.conversation_id) lastConvId = chunk.conversation_id;
        if (chunk.response_id) lastRespId = chunk.response_id;
        if (chunk.choice_id) lastChoiceId = chunk.choice_id;

        if (chunk.reasoning_delta) {
          yield OpenAIAdapter.toChatCompletionChunk(
            chunkId,
            request.model,
            '',
            null,
            chunk.reasoning_delta,
            undefined,
            lastConvId,
            lastRespId,
            lastChoiceId
          );
        }

        if (chunk.text_delta) {
          yield OpenAIAdapter.toChatCompletionChunk(
            chunkId,
            request.model,
            chunk.text_delta,
            null,
            undefined,
            undefined,
            lastConvId,
            lastRespId,
            lastChoiceId
          );
        }

        if (chunk.is_done) {
          yield OpenAIAdapter.toChatCompletionChunk(
            chunkId,
            request.model,
            '',
            'stop',
            undefined,
            chunk.images,
            lastConvId,
            lastRespId,
            lastChoiceId
          );
          break;
        }

        currentResult = await streamIterator.next();
      }

      // Final DONE message
      yield 'data: [DONE]\n\n';

      quotaManager.recordSuccess(targetAccount.id);
      const finalConv = lastConvId || request.upstream_cid || request.conversation_id;
      if (finalConv) {
        accountScheduler.setConversationAffinity(finalConv, targetAccount.id);
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
      const errMsg = err.message || String(err);
      if (!signal?.aborted && !errMsg.includes('CLIENT_ABORT') && !errMsg.includes('AbortError')) {
        quotaManager.recordError(targetAccount.id, err);
      }
      usageService.logRequest({
        request_id: requestId,
        api_key_id: apiKey.id,
        account_id: targetAccount.id,
        model: request.model,
        status: signal?.aborted || errMsg.includes('CLIENT_ABORT') ? 499 : 500,
        latency_ms: Date.now() - startTime,
        error_code: signal?.aborted || errMsg.includes('CLIENT_ABORT') ? 'CLIENT_ABORTED' : 'STREAM_ERROR',
        created_at: new Date().toISOString(),
      });
      throw err;
    } finally {
      accountScheduler.decrementActive(targetAccount.id);
    }
  }
}

export const gatewayService = new GatewayService();
