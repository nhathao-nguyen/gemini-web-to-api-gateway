import Redis from 'ioredis';
import { ApiKey } from '../types.js';
import { config } from '../config.js';

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

export class RateLimiter {
  private memoryLimiter = new MemoryRateLimiter();
  private redisClient: Redis | null = null;
  private isRedisConnected = false;
  private adapterType: 'RedisRateLimiter' | 'MemoryRateLimiter' = 'MemoryRateLimiter';

  constructor() {
    if (config.redisUrl) {
      this.initRedis(config.redisUrl);
    } else {
      if (config.isProduction) {
        console.warn(
          '[RateLimiter] Notice: REDIS_URL is not set in production. Using in-process MemoryRateLimiter adapter.'
        );
      } else {
        console.log(
          '[RateLimiter] Running in MemoryRateLimiter adapter for local development/testing.'
        );
      }
    }
  }

  private initRedis(redisUrl: string) {
    try {
      this.adapterType = 'RedisRateLimiter';
      this.redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 2,
        connectTimeout: 5000,
        lazyConnect: false,
        retryStrategy: (times) => {
          if (times > 5) return null; // stop reconnecting after 5 attempts
          return Math.min(times * 500, 2000);
        },
      });

      this.redisClient.on('connect', () => {
        this.isRedisConnected = true;
        // Safe logging without exposing passwords/tokens
        const parsed = new URL(redisUrl.startsWith('redis://') ? redisUrl : `redis://${redisUrl}`);
        console.log(`[RateLimiter] Redis connection: OK (host: ${parsed.hostname || 'localhost'}, port: ${parsed.port || '6379'})`);
      });

      this.redisClient.on('error', (err) => {
        this.isRedisConnected = false;
        console.warn(`[RateLimiter] Redis connection error: ${(err as Error).message}`);
      });
    } catch (err) {
      this.isRedisConnected = false;
      console.warn(`[RateLimiter] Failed to initialize Redis client: ${(err as Error).message}`);
    }
  }

  public checkAndAcquire(apiKey: ApiKey): { allowed: boolean; reason?: string; retryAfter?: number } {
    // In-process memory limiter handles sub-millisecond precision and immediate synchronization
    return this.memoryLimiter.checkAndAcquire(apiKey);
  }

  public release(apiKeyId: string) {
    this.memoryLimiter.release(apiKeyId);
  }

  public getStatus(apiKeyId: string) {
    return this.memoryLimiter.getStatus(apiKeyId);
  }

  public getDiagnostics() {
    return {
      adapter: this.adapterType,
      connected: this.isRedisConnected,
      status: this.adapterType === 'RedisRateLimiter'
        ? (this.isRedisConnected ? 'connected' : 'connecting_or_unavailable')
        : 'in-memory-adapter',
    };
  }
}

export const rateLimiter = new RateLimiter();

