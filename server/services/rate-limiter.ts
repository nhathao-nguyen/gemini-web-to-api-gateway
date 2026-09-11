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
        throw new Error(
          'FATAL: REDIS_URL environment variable is required in production! In-process memory fallback is prohibited.'
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

  private async checkAndAcquireRedis(
    apiKey: ApiKey
  ): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }> {
    if (!this.redisClient || !this.isRedisConnected) {
      if (config.isProduction) {
        return { allowed: false, reason: 'Redis rate limiting service is unavailable' };
      }
      return this.memoryLimiter.checkAndAcquire(apiKey);
    }

    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const concurKey = `gw:rl:concur:${apiKey.id}`;
    const rpmKey = `gw:rl:rpm:${apiKey.id}`;
    const dailyKey = `gw:rl:daily:${apiKey.id}:${today}`;

    // 1. Check concurrent limits
    if (apiKey.concurrent_limit > 0) {
      const activeConcur = parseInt((await this.redisClient.get(concurKey)) || '0', 10);
      if (activeConcur >= apiKey.concurrent_limit) {
        return {
          allowed: false,
          reason: `Concurrent request limit reached (${apiKey.concurrent_limit} simultaneous requests)`,
          retryAfter: 1,
        };
      }
    }

    // 2. Check RPM via sliding 60-second window in Redis ZSET
    const oneMinuteAgo = now - 60000;
    await this.redisClient.zremrangebyscore(rpmKey, 0, oneMinuteAgo);
    const currentCount = await this.redisClient.zcard(rpmKey);

    if (apiKey.rpm_limit > 0 && currentCount >= apiKey.rpm_limit) {
      const oldestEntries = (await (this.redisClient as any).zrange(rpmKey, 0, 0)) as string[];
      let waitSeconds = 1;
      if (oldestEntries && oldestEntries.length > 0) {
        const oldestTimestamp = parseInt(oldestEntries[0].split('-')[0], 10);
        if (!isNaN(oldestTimestamp)) {
          waitSeconds = Math.max(1, Math.ceil((oldestTimestamp + 60000 - now) / 1000));
        }
      }
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${apiKey.rpm_limit} requests per minute limit reached`,
        retryAfter: waitSeconds,
      };
    }

    // 3. Check Daily request limit
    if (apiKey.daily_request_limit > 0) {
      const dayCount = parseInt((await this.redisClient.get(dailyKey)) || '0', 10);
      if (dayCount >= apiKey.daily_request_limit) {
        return {
          allowed: false,
          reason: `Daily quota limit exceeded: ${apiKey.daily_request_limit} requests per day limit reached`,
          retryAfter: 3600,
        };
      }
    }

    // Acquire lock in Redis
    const pipeline = this.redisClient.pipeline();
    pipeline.incr(concurKey);
    pipeline.expire(concurKey, 300); // 5 min safety TTL in case worker dies
    pipeline.zadd(rpmKey, now, `${now}-${Math.random()}`);
    pipeline.expire(rpmKey, 120);
    pipeline.incr(dailyKey);
    pipeline.expire(dailyKey, 172800); // 2 days
    await pipeline.exec();

    return { allowed: true };
  }

  private async releaseRedis(apiKeyId: string): Promise<void> {
    if (!this.redisClient || !this.isRedisConnected) {
      this.memoryLimiter.release(apiKeyId);
      return;
    }
    const concurKey = `gw:rl:concur:${apiKeyId}`;
    const val = await this.redisClient.decr(concurKey);
    if (val < 0) {
      await this.redisClient.set(concurKey, '0');
    }
  }

  public async checkAndAcquire(
    apiKey: ApiKey
  ): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }> {
    if (this.adapterType === 'RedisRateLimiter' && this.redisClient && this.isRedisConnected) {
      return this.checkAndAcquireRedis(apiKey);
    }
    return this.memoryLimiter.checkAndAcquire(apiKey);
  }

  public async release(apiKeyId: string): Promise<void> {
    if (this.adapterType === 'RedisRateLimiter' && this.redisClient && this.isRedisConnected) {
      await this.releaseRedis(apiKeyId);
    } else {
      this.memoryLimiter.release(apiKeyId);
    }
  }

  public async getStatus(apiKeyId: string): Promise<{
    currentRpm: number;
    currentConcurrent: number;
    dailyUsed: number;
  }> {
    if (this.adapterType === 'RedisRateLimiter' && this.redisClient && this.isRedisConnected) {
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10);
      const oneMinuteAgo = now - 60000;
      await this.redisClient.zremrangebyscore(`gw:rl:rpm:${apiKeyId}`, 0, oneMinuteAgo);
      const currentRpm = await this.redisClient.zcard(`gw:rl:rpm:${apiKeyId}`);
      const currentConcurrent = parseInt((await this.redisClient.get(`gw:rl:concur:${apiKeyId}`)) || '0', 10);
      const dailyUsed = parseInt((await this.redisClient.get(`gw:rl:daily:${apiKeyId}:${today}`)) || '0', 10);
      return {
        currentRpm,
        currentConcurrent: Math.max(0, currentConcurrent),
        dailyUsed,
      };
    }
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

