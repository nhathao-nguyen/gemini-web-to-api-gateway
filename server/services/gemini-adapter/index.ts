import { AIProvider, GeminiAccount, ChatCompletionRequest, AIProviderResult, AIStreamChunk, HealthResult } from '../../types.js';
import { GeminiWebProvider, hasUsableNativeConversationState } from './gemini-web.js';

export { hasUsableNativeConversationState };

export class GeminiProviderRouter implements AIProvider {
  private webProvider = new GeminiWebProvider();

  public async ListModels(account: GeminiAccount): Promise<string[]> {
    return this.webProvider.ListModels(account);
  }

  public async ValidateSession(account: GeminiAccount): Promise<HealthResult> {
    return this.webProvider.ValidateSession(account);
  }

  public invalidateSession(accountId: string): boolean {
    return this.webProvider.invalidateSession(accountId);
  }

  public async ChatCompletion(
    account: GeminiAccount,
    request: ChatCompletionRequest,
    signal?: AbortSignal,
    deadline?: number
  ): Promise<AIProviderResult> {
    return this.webProvider.ChatCompletion(account, request, signal, deadline);
  }

  public ChatCompletionStream(
    account: GeminiAccount,
    request: ChatCompletionRequest,
    signal?: AbortSignal,
    deadline?: number
  ): AsyncIterable<AIStreamChunk> {
    return this.webProvider.ChatCompletionStream(account, request, signal, deadline);
  }

  public async uploadFile(
    account: GeminiAccount,
    filename: string,
    mimeType: string,
    data: Buffer,
    signal?: AbortSignal,
    deadline?: number
  ) {
    return this.webProvider.uploadFile(account, filename, mimeType, data, signal, deadline);
  }

  public async downloadGeneratedImage(
    account: GeminiAccount,
    rawUrl: string,
    targetSize?: number,
    signal?: AbortSignal,
    deadline?: number
  ) {
    return this.webProvider.downloadGeneratedImage(account, rawUrl, targetSize, signal, deadline);
  }

  public getModelCapabilities(modelId: string) {
    return this.webProvider.getModelCapabilities(modelId);
  }

  public async getAccountQuota(account: GeminiAccount) {
    return this.webProvider.fetchAccountQuota(account);
  }

  public async fetchRecentConversations(account: GeminiAccount, limit = 10, deadline?: number) {
    return this.webProvider.fetchRecentConversations(account, limit, deadline);
  }

  public async fetchConversationHistory(account: GeminiAccount, conversationId: string, deadline?: number) {
    return this.webProvider.fetchConversationHistory(account, conversationId, deadline);
  }
}

export const geminiProvider = new GeminiProviderRouter();

