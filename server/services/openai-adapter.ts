import { z } from 'zod';
import crypto from 'crypto';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  AIProviderResult,
  AIStreamChunk,
  OpenAIModel,
} from '../types.js';

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1, 'Model is required'),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.union([z.string(), z.array(z.any())]),
        name: z.string().optional(),
      })
    )
    .min(1, 'At least one message is required'),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  stream: z.boolean().optional().default(false),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  response_format: z.object({ type: z.enum(['text', 'json_object']) }).optional(),
  conversation_id: z.string().optional(),
});

export class OpenAIAdapter {
  /**
   * Convert Gemini result to standard OpenAI ChatCompletionResponse
   */
  public static toChatCompletionResponse(
    model: string,
    result: AIProviderResult
  ): ChatCompletionResponse {
    const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);

    const message: any = {
      role: 'assistant',
      content: result.text,
    };
    if (result.reasoning_content) {
      message.reasoning_content = result.reasoning_content;
    }

    return {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: 'stop',
        },
      ],
      // Note: Gemini Web upstream RPC does not provide authoritative token counters.
      // Usage is calculated via tokenizer heuristic and explicitly documented & flagged as estimated.
      usage: {
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        total_tokens: result.prompt_tokens + result.completion_tokens,
        estimated: true,
      },
      system_fingerprint: 'fp_gemini_gw_01',
    };
  }

  /**
   * Format delta chunk into OpenAI SSE line
   */
  public static toChatCompletionChunk(
    chunkId: string,
    model: string,
    deltaText: string,
    finishReason: 'stop' | null = null,
    reasoningDelta?: string
  ): string {
    const created = Math.floor(Date.now() / 1000);
    const delta: any = {};
    if (deltaText) delta.content = deltaText;
    if (reasoningDelta) delta.reasoning_content = reasoningDelta;

    const chunk: any = {
      id: chunkId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    };

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  /**
   * Format models list to OpenAI GET /v1/models response
   */
  public static toModelListResponse(modelIds: string[]): { object: 'list'; data: OpenAIModel[] } {
    const created = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: modelIds.map((id) => ({
        id,
        object: 'model',
        created,
        owned_by: 'google-gemini-web',
      })),
    };
  }

  /**
   * Standard OpenAI error response format
   */
  public static formatError(message: string, code: string, type = 'invalid_request_error') {
    return {
      error: {
        message,
        type,
        param: null,
        code,
      },
    };
  }
}
