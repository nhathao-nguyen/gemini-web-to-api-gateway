export interface CachedMediaItem {
  buffer: Buffer;
  mimeType: string;
  expiresAt: number;
}

export class RamMediaCache {
  private cache = new Map<string, CachedMediaItem>();
  private maxItems: number;
  private maxItemBytes: number;
  private maxTotalBytes: number;
  private currentBytes = 0;
  private defaultTtlMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options?: {
    maxItems?: number;
    maxItemBytes?: number;
    maxTotalBytes?: number;
    defaultTtlMs?: number;
  }) {
    this.maxItems = options?.maxItems || 200;
    // Default safe LAN bounds: 20MB per item, 256MB total in RAM
    this.maxItemBytes = options?.maxItemBytes || 20 * 1024 * 1024;
    this.maxTotalBytes = options?.maxTotalBytes || 256 * 1024 * 1024;
    this.defaultTtlMs = options?.defaultTtlMs || 2 * 60 * 60 * 1000; // 2 hours

    // Run cleanup periodically
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
  ): boolean {
    if (!id || !buffer) return false;

    // 1. Enforce maxItemBytes
    if (buffer.length > this.maxItemBytes) {
      return false;
    }

    // 2. Prune expired entries first
    this.cleanup();

    // 3. If item already exists, deduct previous bytes
    const existing = this.cache.get(id);
    if (existing) {
      this.currentBytes = Math.max(0, this.currentBytes - existing.buffer.length);
      this.cache.delete(id);
    }

    // 4. If single item exceeds total capacity, cannot cache
    if (buffer.length > this.maxTotalBytes) {
      return false;
    }

    // 5. Evict FIFO until enough space and below maxItems
    while (
      (this.currentBytes + buffer.length > this.maxTotalBytes || this.cache.size >= this.maxItems) &&
      this.cache.size > 0
    ) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      const oldestItem = this.cache.get(oldestKey);
      if (oldestItem) {
        this.currentBytes = Math.max(0, this.currentBytes - oldestItem.buffer.length);
      }
      this.cache.delete(oldestKey);
    }

    // Double-check space after eviction
    if (this.currentBytes + buffer.length > this.maxTotalBytes) {
      return false;
    }

    this.cache.set(id, {
      buffer,
      mimeType,
      expiresAt: Date.now() + ttlMs,
    });
    this.currentBytes += buffer.length;
    return true;
  }

  public getMedia(id: string): { buffer: Buffer; mimeType: string } | null {
    const item = this.cache.get(id);
    if (!item) return null;

    if (Date.now() > item.expiresAt) {
      this.currentBytes = Math.max(0, this.currentBytes - item.buffer.length);
      this.cache.delete(id);
      return null;
    }

    return {
      buffer: item.buffer,
      mimeType: item.mimeType,
    };
  }

  public deleteMedia(id: string): boolean {
    const item = this.cache.get(id);
    if (!item) return false;
    this.currentBytes = Math.max(0, this.currentBytes - item.buffer.length);
    return this.cache.delete(id);
  }

  public cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expiresAt) {
        this.currentBytes = Math.max(0, this.currentBytes - item.buffer.length);
        this.cache.delete(key);
      }
    }
  }

  public clear(): void {
    this.cache.clear();
    this.currentBytes = 0;
  }

  public size(): number {
    return this.cache.size;
  }

  public getCurrentBytes(): number {
    return this.currentBytes;
  }

  public getMaxItemBytes(): number {
    return this.maxItemBytes;
  }

  public getMaxTotalBytes(): number {
    return this.maxTotalBytes;
  }

  public getStats() {
    return {
      items: this.cache.size,
      currentBytes: this.currentBytes,
      maxItems: this.maxItems,
      maxItemBytes: this.maxItemBytes,
      maxTotalBytes: this.maxTotalBytes,
    };
  }
}

export const ramMediaCache = new RamMediaCache();
