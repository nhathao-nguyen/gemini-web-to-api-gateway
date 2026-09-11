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
  upstream_cid: z.string().optional(),
  upstream_rid: z.string().optional(),
  upstream_rcid: z.string().optional(),
  thinking: z.boolean().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
});

export const ImageGenerationRequestSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
  model: z.string().optional(),
  n: z.number().optional().default(1),
  size: z.string().optional().default('1024x1024'),
  response_format: z.enum(['url', 'b64_json']).optional().default('b64_json'),
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
    if (result.images && result.images.length > 0) {
      message.images = result.images;
      if (!result.text.includes('![')) {
        const imageMarkdown = result.images
          .map((img) => `\n\n![${img.title || 'Generated Image'}](${img.url})`)
          .join('');
        message.content = (result.text + imageMarkdown).trim();
      }
    }

    const response: any = {
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

    if (result.conversation_id) {
      response.conversation_id = result.conversation_id;
    }
    if (result.response_id) {
      response.response_id = result.response_id;
    }
    if (result.choice_id) {
      response.choice_id = result.choice_id;
    }

    return response;
  }

  /**
   * Format delta chunk into OpenAI SSE line
   */
  public static toChatCompletionChunk(
    chunkId: string,
    model: string,
    deltaText: string,
    finishReason: 'stop' | null = null,
    reasoningDelta?: string,
    images?: any[],
    conversationId?: string,
    responseId?: string,
    choiceId?: string
  ): string {
    const created = Math.floor(Date.now() / 1000);
    const delta: any = {};
    if (deltaText) delta.content = deltaText;
    if (reasoningDelta) delta.reasoning_content = reasoningDelta;
    if (images && images.length > 0) delta.images = images;

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

    if (conversationId) {
      chunk.conversation_id = conversationId;
    }
    if (responseId) {
      chunk.response_id = responseId;
    }
    if (choiceId) {
      chunk.choice_id = choiceId;
    }

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  /**
   * Format models list to OpenAI GET /v1/models response
   */
  public static toModelListResponse(
    modelIds: string[],
    capabilitiesMap?: Record<string, any>
  ): { object: 'list'; data: any[] } {
    const created = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: modelIds.map((id) => ({
        id,
        object: 'model',
        created,
        owned_by: 'google-gemini-web',
        capabilities: capabilitiesMap?.[id] || {
          text: true,
          vision: true,
          files: true,
          thinking: id.includes('thinking') || id.includes('pro'),
          image_generation: true,
          video_generation: false,
        },
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

