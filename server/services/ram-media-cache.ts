export interface CachedMediaItem {
  buffer: Buffer;
  mimeType: string;
  expiresAt: number;
}

export class RamMediaCache {
  private cache = new Map<string, CachedMediaItem>();
  private maxItems: number;
  private defaultTtlMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options?: { maxItems?: number; defaultTtlMs?: number }) {
    this.maxItems = options?.maxItems || 200;
    this.defaultTtlMs = options?.defaultTtlMs || 2 * 60 * 60 * 1000; // 2 hours

    // Run cleanup every 10 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 10 * 60 * 1000);
    this.cleanupInterval.unref();
  }

  public saveMedia(
    id: string,
    buffer: Buffer,
    mimeType: string = 'image/png',
    ttlMs: number = this.defaultTtlMs
  ): void {
    // If over capacity, prune expired first
    if (this.cache.size >= this.maxItems) {
      this.cleanup();
      // If still over capacity, remove oldest entry (FIFO)
      if (this.cache.size >= this.maxItems) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) {
          this.cache.delete(oldestKey);
        }
      }
    }

    this.cache.set(id, {
      buffer,
      mimeType,
      expiresAt: Date.now() + ttlMs,
    });
  }

  public getMedia(id: string): { buffer: Buffer; mimeType: string } | null {
    const item = this.cache.get(id);
    if (!item) return null;

    if (Date.now() > item.expiresAt) {
      this.cache.delete(id);
      return null;
    }

    return {
      buffer: item.buffer,
      mimeType: item.mimeType,
    };
  }

  public deleteMedia(id: string): boolean {
    return this.cache.delete(id);
  }

  public cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }
}

export const ramMediaCache = new RamMediaCache();
