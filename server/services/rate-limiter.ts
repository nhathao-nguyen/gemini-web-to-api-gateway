import { ApiKey } from '../types.js';

interface RateLimitBucket {
  minuteTimestamps: number[];
  dayCount: number;
  dayDate: string;
  activeConcurrent: number;
}

export class MemoryRateLimiter {
  private buckets = new Map<string, RateLimitBucket>();

  private getBucket(apiKeyId: string): RateLimitBucket {
    const today = new Date().toISOString().slice(0, 10);
    let bucket = this.buckets.get(apiKeyId);

    if (!bucket) {
      bucket = {
        minuteTimestamps: [],
        dayCount: 0,
        dayDate: today,
        activeConcurrent: 0,
      };
      this.buckets.set(apiKeyId, bucket);
    }

    if (bucket.dayDate !== today) {
      bucket.dayDate = today;
      bucket.dayCount = 0;
    }

    return bucket;
  }

  public checkAndAcquire(apiKey: ApiKey): { allowed: boolean; reason?: string; retryAfter?: number } {
    const bucket = this.getBucket(apiKey.id);
    const now = Date.now();

    // 1. Check concurrent limits
    if (apiKey.concurrent_limit > 0 && bucket.activeConcurrent >= apiKey.concurrent_limit) {
      return {
        allowed: false,
        reason: `Concurrent request limit reached (${apiKey.concurrent_limit} simultaneous requests)`,
        retryAfter: 1,
      };
    }

    // 2. Check RPM (Requests Per Minute) via sliding 60-second window
    const oneMinuteAgo = now - 60000;
    bucket.minuteTimestamps = bucket.minuteTimestamps.filter((t) => t > oneMinuteAgo);

    if (apiKey.rpm_limit > 0 && bucket.minuteTimestamps.length >= apiKey.rpm_limit) {
      const oldestInWindow = bucket.minuteTimestamps[0];
      const waitSeconds = Math.ceil((oldestInWindow + 60000 - now) / 1000);
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${apiKey.rpm_limit} requests per minute limit reached`,
        retryAfter: Math.max(1, waitSeconds),
      };
    }

    // 3. Check Daily request limit
    if (apiKey.daily_request_limit > 0 && bucket.dayCount >= apiKey.daily_request_limit) {
      return {
        allowed: false,
        reason: `Daily quota limit exceeded: ${apiKey.daily_request_limit} requests per day limit reached`,
        retryAfter: 3600,
      };
    }

    // Acquire lock
    bucket.minuteTimestamps.push(now);
    bucket.dayCount++;
    bucket.activeConcurrent++;

    return { allowed: true };
  }

  public release(apiKeyId: string) {
    const bucket = this.buckets.get(apiKeyId);
    if (bucket) {
      bucket.activeConcurrent = Math.max(0, bucket.activeConcurrent - 1);
    }
  }

  public getStatus(apiKeyId: string) {
    const bucket = this.buckets.get(apiKeyId);
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const currentRpm = bucket ? bucket.minuteTimestamps.filter((t) => t > oneMinuteAgo).length : 0;
    const currentConcurrent = bucket ? bucket.activeConcurrent : 0;
    const dailyUsed = bucket ? bucket.dayCount : 0;

    return {
      currentRpm,
      currentConcurrent,
      dailyUsed,
    };
  }
}

/**
 * Desktop builds are single-process by design, so the in-memory sliding-window
 * limiter is the only adapter. (The old Redis adapter was removed: it was
 * non-atomic check-then-act and added an external dependency for no benefit
 * in personal/LAN use.)
 */
export class RateLimiter {
  private memoryLimiter = new MemoryRateLimiter();

  public async checkAndAcquire(
    apiKey: ApiKey
  ): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }> {
    return this.memoryLimiter.checkAndAcquire(apiKey);
  }

  public async release(apiKeyId: string): Promise<void> {
    this.memoryLimiter.release(apiKeyId);
  }

  public async getStatus(apiKeyId: string): Promise<{
    currentRpm: number;
    currentConcurrent: number;
    dailyUsed: number;
  }> {
    return this.memoryLimiter.getStatus(apiKeyId);
  }

  public getDiagnostics() {
    return {
      adapter: 'MemoryRateLimiter' as const,
      connected: true,
      status: 'in-memory-adapter' as const,
    };
  }
}

export const rateLimiter = new RateLimiter();

