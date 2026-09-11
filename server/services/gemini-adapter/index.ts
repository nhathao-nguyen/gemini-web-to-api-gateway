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
}

export const geminiProvider = new GeminiProviderRouter();
