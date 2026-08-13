import type { Redis } from "ioredis";
import { UnifiedChatRequest, UnifiedChatResponse } from "../providers/types.js";
import { cacheKeyFor } from "./keyNormalizer.js";
import { env } from "../config/env.js";

const STATS_HITS_KEY = "cache:stats:hits";
const STATS_MISSES_KEY = "cache:stats:misses";

export interface CachedEntry {
  response: UnifiedChatResponse;
  cachedAt: string;
}

export class CacheStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number = env.CACHE_TTL_SECONDS,
  ) {}

  async get(request: UnifiedChatRequest): Promise<UnifiedChatResponse | null> {
    const key = cacheKeyFor(request);
    const raw = await this.redis.get(key);
    if (!raw) {
      await this.redis.incr(STATS_MISSES_KEY);
      return null;
    }
    await this.redis.incr(STATS_HITS_KEY);
    const entry = JSON.parse(raw) as CachedEntry;
    return entry.response;
  }

  async set(request: UnifiedChatRequest, response: UnifiedChatResponse): Promise<void> {
    const key = cacheKeyFor(request);
    const entry: CachedEntry = { response, cachedAt: new Date().toISOString() };
    await this.redis.set(key, JSON.stringify(entry), "EX", this.ttlSeconds);
  }

  async stats(): Promise<{ hits: number; misses: number; hitRate: number }> {
    const [hits, misses] = await Promise.all([
      this.redis.get(STATS_HITS_KEY).then((v: string | null) => Number(v ?? 0)),
      this.redis.get(STATS_MISSES_KEY).then((v: string | null) => Number(v ?? 0)),
    ]);
    const total = hits + misses;
    return { hits, misses, hitRate: total === 0 ? 0 : hits / total };
  }

  async resetStats(): Promise<void> {
    await this.redis.del(STATS_HITS_KEY, STATS_MISSES_KEY);
  }
}
