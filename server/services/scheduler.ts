import { db } from '../db/database.js';
import { GeminiAccount } from '../types.js';
import { quotaManager } from './quota-manager.js';

interface AffinityEntry {
  accountId: string;
  expiresAt: number;
}
type StickySessionEntry = AffinityEntry;

export const DEFAULT_GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.1-pro',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
];

export class AccountScheduler {
  // In-flight active requests per account ID
  private activeRequests = new Map<string, number>();

  // Sticky sessions mapping: conversation_id -> { accountId, expiresAt }
  private stickySessions = new Map<string, StickySessionEntry>();

  // Hard conversation affinity mapping: cid -> { accountId, expiresAt } (24h TTL)
  private conversationAffinity = new Map<string, AffinityEntry>();

  // Hard uploaded file affinity mapping: fileId -> { accountId, expiresAt } (24h TTL)
  private uploadedFileAffinity = new Map<string, AffinityEntry>();

  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => {
      this.cleanupAffinities();
    }, 10 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  /**
   * Register start of in-flight request
   */
  public incrementActive(accountId: string) {
    const curr = this.activeRequests.get(accountId) || 0;
    this.activeRequests.set(accountId, curr + 1);
  }

  /**
   * Register completion of in-flight request
   */
  public decrementActive(accountId: string) {
    const curr = this.activeRequests.get(accountId) || 0;
    this.activeRequests.set(accountId, Math.max(0, curr - 1));
  }

  /**
   * Set conversation affinity with TTL (default 24h)
   */
  public setConversationAffinity(conversationId: string, accountId: string, ttlMs = 24 * 60 * 60 * 1000) {
    if (!conversationId) return;
    this.conversationAffinity.set(conversationId, {
      accountId,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Get conversation affinity if not expired
   */
  public getConversationAffinity(conversationId: string): string | null {
    if (!conversationId) return null;
    const entry = this.conversationAffinity.get(conversationId);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.conversationAffinity.delete(conversationId);
      return null;
    }
    return entry.accountId;
  }

  /**
   * Set uploaded file affinity with TTL (default 24h)
   */
  public setUploadedFileAffinity(fileId: string, accountId: string, ttlMs = 24 * 60 * 60 * 1000) {
    if (!fileId) return;
    this.uploadedFileAffinity.set(fileId, {
      accountId,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Get uploaded file affinity if not expired
   */
  public getUploadedFileAffinity(fileId: string): string | null {
    if (!fileId) return null;
    const entry = this.uploadedFileAffinity.get(fileId);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.uploadedFileAffinity.delete(fileId);
      return null;
    }
    return entry.accountId;
  }

  /**
   * Validate all uploaded files in a request:
   * - unknown or expired -> throw FILE_NOT_FOUND_OR_EXPIRED
   * - multiple accounts -> throw FILE_ACCOUNT_MISMATCH
   * - return target account ID
   */
  public checkUploadedFilesAffinity(files: Array<{ id: string; name?: string }>): string {
    if (!files || files.length === 0) {
      throw new Error('FILE_NOT_FOUND_OR_EXPIRED: No files specified');
    }

    let targetAccountId: string | null = null;
    for (const f of files) {
      const accountId = this.getUploadedFileAffinity(f.id);
      if (!accountId) {
        throw new Error(`FILE_NOT_FOUND_OR_EXPIRED: Uploaded file "${f.name || f.id}" does not exist or has expired`);
      }
      if (!targetAccountId) {
        targetAccountId = accountId;
      } else if (targetAccountId !== accountId) {
        throw new Error('FILE_ACCOUNT_MISMATCH: Uploaded files belong to multiple different Gemini accounts and cannot be combined in a single request');
      }
    }

    return targetAccountId!;
  }

  /**
   * Cleanup expired affinities
   */
  public cleanupAffinities() {
    const now = Date.now();
    for (const [k, v] of this.stickySessions.entries()) {
      if (now > v.expiresAt) this.stickySessions.delete(k);
    }
    for (const [k, v] of this.conversationAffinity.entries()) {
      if (now > v.expiresAt) this.conversationAffinity.delete(k);
    }
    for (const [k, v] of this.uploadedFileAffinity.entries()) {
      if (now > v.expiresAt) this.uploadedFileAffinity.delete(k);
    }
  }

  /**
   * Clear in-memory affinity tables (for testing restart semantics)
   */
  public clearAffinities() {
    this.stickySessions.clear();
    this.conversationAffinity.clear();
    this.uploadedFileAffinity.clear();
  }

  /**
   * Bind conversation_id to account_id with TTL (default 30 mins)
   */
  public setStickySession(conversationId: string, accountId: string, ttlMs = 30 * 60 * 1000) {
    // Prune expired sessions if map grows to avoid unbounded memory leak
    if (this.stickySessions.size > 2000) {
      const now = Date.now();
      for (const [k, v] of this.stickySessions.entries()) {
        if (now > v.expiresAt) {
          this.stickySessions.delete(k);
        }
      }
    }

    this.stickySessions.set(conversationId, {
      accountId,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Find sticky account if valid and active
   */
  public getStickyAccount(conversationId: string, requestedModel: string): GeminiAccount | null {
    const entry = this.stickySessions.get(conversationId);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.stickySessions.delete(conversationId);
      return null;
    }

    const account = db.getAccountById(entry.accountId);
    if (!account) return null;

    // Check if account is still active and supports model
    if (this.isAccountEligible(account, requestedModel)) {
      return account;
    }

    return null;
  }

  /**
   * Check eligibility for a model
   */
  public isAccountEligible(account: GeminiAccount, requestedModel: string): boolean {
    if (account.status === 'DISABLED' || account.status === 'SESSION_EXPIRED') {
      return false;
    }

    if (quotaManager.isCoolingDown(account)) {
      return false;
    }

    // Model compatibility: if supported_models is empty, allow; or check if model is listed
    if (account.supported_models && account.supported_models.length > 0) {
      const match = account.supported_models.some((m) =>
        m.toLowerCase().includes(requestedModel.toLowerCase()) ||
        requestedModel.toLowerCase().includes(m.toLowerCase()) ||
        m === '*'
      );
      if (!match) return false;
    }

    return true;
  }

  /**
   * Calculate account selection score:
   * score = priority_weight + health_score - active_request_penalty - recent_error_penalty
   */
  public calculateScore(account: GeminiAccount): number {
    const priorityWeight = (account.priority || 10) * (account.weight || 1);
    
    // Health score based on status
    let healthScore = 50;
    if (account.status === 'ACTIVE') healthScore = 100;
    else if (account.status === 'ERROR') healthScore = 20;

    // Active requests penalty (each ongoing request decreases score by 15)
    const active = this.activeRequests.get(account.id) || 0;
    const activePenalty = active * 15;

    // Recent errors penalty
    const errorPenalty = (account.consecutive_errors || 0) * 25;

    // Least-recently used bonus (accounts unused for longer gain slight bonus)
    let lruBonus = 0;
    if (account.last_success_at) {
      const msSinceLast = Date.now() - new Date(account.last_success_at).getTime();
      lruBonus = Math.min(20, Math.floor(msSinceLast / 10000));
    } else {
      lruBonus = 10;
    }

    return priorityWeight + healthScore + lruBonus - activePenalty - errorPenalty;
  }

  /**
   * Select best account from pool, optionally excluding already failed account IDs for failover
   */
  public selectAccount(requestedModel: string, excludedIds: string[] = []): GeminiAccount | null {
    const allAccounts = db.getAccounts();
    const eligible = allAccounts.filter(
      (a) => !excludedIds.includes(a.id) && this.isAccountEligible(a, requestedModel)
    );

    if (eligible.length === 0) {
      return null;
    }

    // Rank by score descending
    eligible.sort((a, b) => this.calculateScore(b) - this.calculateScore(a));

    return eligible[0];
  }

  /**
   * Select any active eligible account without binding to a specific model
   */
  public selectAnyActiveAccount(excludedIds: string[] = []): GeminiAccount | null {
    const allAccounts = db.getAccounts();
    const eligible = allAccounts.filter(
      (a) =>
        !excludedIds.includes(a.id) &&
        a.status === 'ACTIVE' &&
        !quotaManager.isCoolingDown(a)
    );

    if (eligible.length === 0) {
      return null;
    }

    eligible.sort((a, b) => this.calculateScore(b) - this.calculateScore(a));
    return eligible[0];
  }

  /**
   * Get dynamic list of currently available models across all eligible active accounts
   */
  public getAvailableModels(): string[] {
    const allAccounts = db.getAccounts();
    const modelSet = new Set<string>();

    for (const account of allAccounts) {
      if (account.status === 'ACTIVE' && !quotaManager.isCoolingDown(account)) {
        if (account.supported_models && account.supported_models.length > 0) {
          for (const m of account.supported_models) {
            if (m !== '*') modelSet.add(m);
          }
        }
      }
    }

    // Fallback: If accounts exist and are active with unrestricted model access, provide default models
    if (modelSet.size === 0) {
      const hasActiveGeneralAccount = allAccounts.some(
        (a) =>
          a.status === 'ACTIVE' &&
          !quotaManager.isCoolingDown(a) &&
          (!a.supported_models || a.supported_models.length === 0 || a.supported_models.includes('*'))
      );
      if (hasActiveGeneralAccount) {
        return [...DEFAULT_GEMINI_MODELS];
      }
    }

    return Array.from(modelSet);
  }
}

export const accountScheduler = new AccountScheduler();
