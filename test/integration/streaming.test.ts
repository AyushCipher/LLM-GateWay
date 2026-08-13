import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { createTestRedis } from "./testRedis.js";
import { buildProviderRegistry } from "../../src/providers/registry.js";
import { CacheStore } from "../../src/cache/cacheStore.js";
import { LatencyTracker } from "../../src/observability/latencyTracker.js";
import { HealthTracker } from "../../src/routing/health.js";
import { StaticPriorityStrategy } from "../../src/routing/strategies/staticPriority.js";
import { Router, StreamEvent } from "../../src/routing/router.js";
import { setFault } from "../../src/providers/faultInjector.js";
import { UnifiedChatRequest } from "../../src/providers/types.js";
import { env, providerPriority } from "../../src/config/env.js";

const liveProvidersAvailable = [env.GROQ_API_KEY, env.GEMINI_API_KEY, env.OPENROUTER_API_KEY].filter(Boolean).length >= 2;

let redis: Redis;
let router: Router;

function isDone(e: StreamEvent): e is Extract<StreamEvent, { type: "done" }> {
  return e.type === "done";
}

async function collectStream(request: UnifiedChatRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of router.routeStream(request, "static_priority")) events.push(event);
  return events;
}

describe.skipIf(!liveProvidersAvailable)("Router.routeStream (real providers + real Redis, fault-injected)", () => {
  beforeEach(async () => {
    redis = createTestRedis(5);
    await redis.flushdb();

    const registry = buildProviderRegistry(redis);
    const cacheStore = new CacheStore(redis, 60);
    const latencyTracker = new LatencyTracker(redis);
    const healthTracker = new HealthTracker(redis, 5);
    const strategy = new StaticPriorityStrategy(providerPriority);

    router = new Router(registry, cacheStore, latencyTracker, healthTracker, { static_priority: strategy });
  });

  afterEach(async () => {
    for (const p of providerPriority) {
      await setFault(redis, p, "clear");
    }
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("streams real chunks followed by a done event on the happy path", async () => {
    const events = await collectStream({ model: "default", messages: [{ role: "user", content: "Count from 1 to 3." }], maxTokens: 20 });

    const chunks = events.filter((e) => e.type === "chunk");
    const done = events.find(isDone);

    expect(chunks.length).toBeGreaterThan(0);
    expect(done).toBeDefined();
    expect(done!.response.content.length).toBeGreaterThan(0);
    expect(done!.attempts.length).toBeGreaterThanOrEqual(1);
    expect(done!.attempts.at(-1)!.outcome).toBe("success");
  }, 30000);

  it("falls back to the next provider before the first chunk when the primary is fault-injected", async () => {
    const primary = providerPriority[0]!;
    await setFault(redis, primary, "error_5xx");

    const events = await collectStream({ model: "default", messages: [{ role: "user", content: "Say exactly: ok" }], maxTokens: 10 });
    const done = events.find(isDone);

    expect(done).toBeDefined();
    expect(done!.response.provider).not.toBe(primary);
    expect(done!.attempts[0]!.provider).toBe(primary);
    expect(done!.attempts[0]!.outcome).toBe("error");
    expect(events.filter((e) => e.type === "chunk").length).toBeGreaterThan(0);
  }, 30000);

  it("emits a single error event when every provider fails before streaming begins", async () => {
    for (const p of providerPriority) {
      await setFault(redis, p, "error_5xx");
    }

    const events = await collectStream({ model: "default", messages: [{ role: "user", content: "Say exactly: ok" }], maxTokens: 10 });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
  }, 30000);

  it("serves an exact cache hit as a single chunk plus a done event with no provider attempts", async () => {
    const request: UnifiedChatRequest = { model: "default", messages: [{ role: "user", content: "Cache me for streaming" }], maxTokens: 10 };

    await collectStream(request);
    const events = await collectStream(request);

    const chunkEvents = events.filter((e) => e.type === "chunk");
    const done = events.find(isDone);

    expect(chunkEvents).toHaveLength(1);
    expect(done).toBeDefined();
    expect(done!.cacheHit).toBe(true);
    expect(done!.cacheType).toBe("exact");
    expect(done!.attempts).toHaveLength(0);
  }, 30000);
});
