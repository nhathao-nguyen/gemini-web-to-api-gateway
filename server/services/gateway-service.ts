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

    // 1. Model permission check
    if (!apiKeyManager.isModelAllowed(apiKey, request.model)) {
      throw new Error(`MODEL_NOT_ALLOWED: Your API key is not permitted to access model "${request.model}"`);
    }

    // 2. Attach existing conversation state from DB if requested
    let localConv = request.conversation_id ? db.getConversation(request.conversation_id) : undefined;
    if (localConv) {
      request.upstream_cid = localConv.upstream_cid || request.upstream_cid;
      request.upstream_rid = localConv.upstream_rid || request.upstream_rid;
      request.upstream_rcid = localConv.upstream_rcid || request.upstream_rcid;

      // Log user message to conversation history
      const lastUserMsg = [...request.messages].reverse().find((m) => m.role === 'user');
      const userText = lastUserMsg
        ? typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : JSON.stringify(lastUserMsg.content)
        : '';
      if (userText) {
        db.createMessage({
          id: `msg_${crypto.randomBytes(8).toString('hex')}`,
          conversation_id: localConv.id,
          role: 'user',
          content: userText,
          created_at: new Date().toISOString(),
        });
      }
    } else if (request.conversation_id?.startsWith('c_') && !request.upstream_cid) {
      request.upstream_cid = request.conversation_id;
    }

    const excludedIds: string[] = [];
    const maxAttempts = config.maxUpstreamAttempts || 2;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let targetAccount: GeminiAccount | null = null;

      // Check sticky session on first attempt
      if (attempt === 1 && (localConv?.account_id || request.conversation_id)) {
        const convKey = localConv?.id || request.conversation_id!;
        targetAccount = accountScheduler.getStickyAccount(convKey, request.model);
        if (!targetAccount && localConv?.account_id) {
          const accs = db.getAccounts();
          targetAccount = accs.find((a) => a.id === localConv!.account_id && a.status === 'ACTIVE') || null;
        }
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

        // Cache generated media if any
        if (result.images && result.images.length > 0) {
          for (const img of result.images) {
            try {
              const downloaded = await geminiProvider.downloadGeneratedImage(targetAccount, img.url);
              const b64 = downloaded.data.toString('base64');
              img.b64_json = b64;
              const mediaId = `media_${crypto.randomBytes(8).toString('hex')}`;
              db.saveMediaCache({
                id: mediaId,
                account_id: targetAccount.id,
                upstream_url: img.url,
                mime_type: downloaded.mimeType,
                file_name: img.title || 'generated.png',
                data_b64: b64,
                created_at: new Date().toISOString(),
              });
              img.url = `/v1/media/${mediaId}`;
            } catch (dlErr) {
              console.warn('[Gateway] Media cache download error:', dlErr);
            }
          }
        }

        // Save sticky conversation if conversation_id was provided or generated
        const convId = localConv?.id || request.conversation_id || result.conversation_id;
        if (convId) {
          accountScheduler.setStickySession(convId, targetAccount.id);
        }

        // Update persistent conversation record & store assistant message
        if (localConv) {
          db.updateConversation(localConv.id, {
            account_id: targetAccount.id,
            upstream_cid: result.conversation_id || localConv.upstream_cid,
            upstream_rid: result.response_id || localConv.upstream_rid,
            upstream_rcid: result.choice_id || localConv.upstream_rcid,
          });

          db.createMessage({
            id: `msg_${crypto.randomBytes(8).toString('hex')}`,
            conversation_id: localConv.id,
            role: 'assistant',
            content: result.text,
            reasoning_content: result.reasoning_content,
            generated_media: result.images,
            created_at: new Date().toISOString(),
          });
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
   * Execute dedicated image generation via Gemini Web session
   */
  public async handleImageGeneration(
    request: ImageGenerationRequest,
    apiKey: ApiKey,
    requestId: string
  ): Promise<{ created: number; data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> }> {
    const startTime = Date.now();
    const modelToUse = request.model || 'gemini-3.1-pro';

    const targetAccount = accountScheduler.selectAccount(modelToUse);
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

      try {
        const downloaded = await geminiProvider.downloadGeneratedImage(targetAccount, generatedImg.url);
        b64 = downloaded.data.toString('base64');
        mediaId = `media_${crypto.randomBytes(8).toString('hex')}`;

        db.saveMediaCache({
          id: mediaId,
          account_id: targetAccount.id,
          upstream_url: generatedImg.url,
          mime_type: downloaded.mimeType,
          file_name: generatedImg.title || 'generated.png',
          data_b64: b64,
          created_at: new Date().toISOString(),
        });
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

    if (!apiKeyManager.isModelAllowed(apiKey, request.model)) {
      throw new Error(`MODEL_NOT_ALLOWED: Your API key is not permitted to access model "${request.model}"`);
    }

    let localConv = request.conversation_id ? db.getConversation(request.conversation_id) : undefined;
    if (localConv) {
      request.upstream_cid = localConv.upstream_cid || request.upstream_cid;
      request.upstream_rid = localConv.upstream_rid || request.upstream_rid;
      request.upstream_rcid = localConv.upstream_rcid || request.upstream_rcid;
    } else if (request.conversation_id?.startsWith('c_') && !request.upstream_cid) {
      request.upstream_cid = request.conversation_id;
    }

    const excludedIds: string[] = [];
    const maxAttempts = config.maxUpstreamAttempts || 2;
    let targetAccount: GeminiAccount | null = null;
    let stream: AsyncIterable<any> | null = null;
    let streamIterator: AsyncIterator<any> | null = null;
    let firstStreamResult: IteratorResult<any> | null = null;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      targetAccount = null;
      if (attempt === 1 && (localConv?.account_id || request.conversation_id)) {
        const convKey = localConv?.id || request.conversation_id!;
        targetAccount = accountScheduler.getStickyAccount(convKey, request.model);
        if (!targetAccount && localConv?.account_id) {
          const accs = db.getAccounts();
          targetAccount = accs.find((a) => a.id === localConv!.account_id && a.status === 'ACTIVE') || null;
        }
      }
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
        stream = geminiProvider.ChatCompletionStream(targetAccount, request, signal);
        streamIterator = stream[Symbol.asyncIterator]();
        firstStreamResult = await streamIterator.next();
        break; // Successfully connected and obtained first stream frame
      } catch (connErr: any) {
        lastError = connErr;
        accountScheduler.decrementActive(targetAccount.id);
        quotaManager.recordError(targetAccount.id, connErr);
        excludedIds.push(targetAccount.id);
        console.warn(
          `[Gateway Stream] Attempt ${attempt}/${maxAttempts} failed on account "${targetAccount.name}": ${redactString(
            connErr.message || String(connErr)
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
    let fullText = '';
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
          fullText += chunk.text_delta;
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
      const finalConv = localConv?.id || request.conversation_id || lastConvId;
      if (finalConv) {
        accountScheduler.setStickySession(finalConv, targetAccount.id);
      }

      if (localConv) {
        db.updateConversation(localConv.id, {
          account_id: targetAccount.id,
          upstream_cid: lastConvId || localConv.upstream_cid,
          upstream_rid: lastRespId || localConv.upstream_rid,
          upstream_rcid: lastChoiceId || localConv.upstream_rcid,
        });

        db.createMessage({
          id: `msg_${crypto.randomBytes(8).toString('hex')}`,
          conversation_id: localConv.id,
          role: 'assistant',
          content: fullText,
          created_at: new Date().toISOString(),
        });
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

