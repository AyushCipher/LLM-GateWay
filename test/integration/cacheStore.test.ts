import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { createTestRedis } from "./testRedis.js";
import { CacheStore } from "../../src/cache/cacheStore.js";
import { UnifiedChatRequest, UnifiedChatResponse } from "../../src/providers/types.js";

const request: UnifiedChatRequest = {
  model: "default",
  messages: [{ role: "user", content: "What is 2+2?" }],
};

const response: UnifiedChatResponse = {
  provider: "groq",
  model: "llama-3.1-8b-instant",
  content: "4",
  usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
  raw: {},
};

let redis: Redis;
let store: CacheStore;

describe("CacheStore (real Redis)", () => {
  beforeEach(async () => {
    redis = createTestRedis(2);
    await redis.flushdb();
    store = new CacheStore(redis, 2);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("misses on first read and hits after a write", async () => {
    const miss = await store.get(request);
    expect(miss).toBeNull();

    await store.set(request, response);

    const hit = await store.get(request);
    expect(hit).toEqual(response);
  });

  it("tracks hit/miss stats accurately", async () => {
    await store.get(request); // miss
    await store.set(request, response);
    await store.get(request); // hit
    await store.get(request); // hit

    const stats = await store.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(2);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
  });

  it("expires entries after the configured TTL", async () => {
    await store.set(request, response);
    const immediate = await store.get(request);
    expect(immediate).toEqual(response);

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const afterExpiry = await store.get(request);
    expect(afterExpiry).toBeNull();
  }, 10000);

  it("treats distinct requests as distinct keys", async () => {
    const other: UnifiedChatRequest = { model: "default", messages: [{ role: "user", content: "different prompt" }] };
    await store.set(request, response);
    const miss = await store.get(other);
    expect(miss).toBeNull();
  });
});
