import { AIProvider, GeminiAccount, ChatCompletionRequest, AIProviderResult, AIStreamChunk, HealthResult } from '../../types.js';
import { GeminiWebProvider } from './gemini-web.js';

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
    signal?: AbortSignal
  ): Promise<AIProviderResult> {
    return this.webProvider.ChatCompletion(account, request, signal);
  }

  public ChatCompletionStream(
    account: GeminiAccount,
    request: ChatCompletionRequest,
    signal?: AbortSignal
  ): AsyncIterable<AIStreamChunk> {
    return this.webProvider.ChatCompletionStream(account, request, signal);
  }

  public async uploadFile(

    account: GeminiAccount,
    filename: string,
    mimeType: string,
    data: Buffer
  ) {
    return this.webProvider.uploadFile(account, filename, mimeType, data);
  }

  public async downloadGeneratedImage(
    account: GeminiAccount,
    rawUrl: string,
    targetSize?: number
  ) {
    return this.webProvider.downloadGeneratedImage(account, rawUrl, targetSize);
  }

  public getModelCapabilities(modelId: string) {
    return this.webProvider.getModelCapabilities(modelId);
  }

  public async getAccountQuota(account: GeminiAccount) {
    return this.webProvider.fetchAccountQuota(account);
  }

  public async fetchRecentConversations(account: GeminiAccount, limit = 10) {
    return this.webProvider.fetchRecentConversations(account, limit);
  }

  public async fetchConversationHistory(account: GeminiAccount, conversationId: string) {
    return this.webProvider.fetchConversationHistory(account, conversationId);
  }
}

export const geminiProvider = new GeminiProviderRouter();

