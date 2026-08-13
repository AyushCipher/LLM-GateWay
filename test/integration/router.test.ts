import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { createTestRedis } from "./testRedis.js";
import { buildProviderRegistry } from "../../src/providers/registry.js";
import { CacheStore } from "../../src/cache/cacheStore.js";
import { LatencyTracker } from "../../src/observability/latencyTracker.js";
import { HealthTracker } from "../../src/routing/health.js";
import { StaticPriorityStrategy } from "../../src/routing/strategies/staticPriority.js";
import { AllProvidersFailedError, Router } from "../../src/routing/router.js";
import { setFault } from "../../src/providers/faultInjector.js";
import { UnifiedChatRequest } from "../../src/providers/types.js";
import { env, providerPriority } from "../../src/config/env.js";

const liveProvidersAvailable = [env.GROQ_API_KEY, env.GEMINI_API_KEY, env.OPENROUTER_API_KEY].filter(Boolean).length >= 2;

let redis: Redis;
let router: Router;

describe.skipIf(!liveProvidersAvailable)("Router fallback (real providers + real Redis, fault-injected)", () => {
  beforeEach(async () => {
    redis = createTestRedis(4);
    await redis.flushdb();

    const registry = buildProviderRegistry(redis);
    const cacheStore = new CacheStore(redis, 60);
    const latencyTracker = new LatencyTracker(redis);
    const healthTracker = new HealthTracker(redis, 5);
    const strategy = new StaticPriorityStrategy(providerPriority);

    router = new Router(registry, cacheStore, latencyTracker, healthTracker, { static_priority: strategy });
  });

  afterEach(async () => {
    // Clear any faults so later tests / the dev server aren't left in a broken state.
    for (const p of providerPriority) {
      await setFault(redis, p, "clear");
    }
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("succeeds via the primary provider when nothing is faulted", async () => {
    const result = await router.route(
      { model: "default", messages: [{ role: "user", content: "Say exactly: ok" }], maxTokens: 10 },
      "static_priority",
    );
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.outcome).toBe("success");
    expect(result.attempts[0]!.provider).toBe(providerPriority[0]);
  });

  it("falls back to the next provider when the primary is fault-injected, and the request still succeeds", async () => {
    const primary = providerPriority[0]!;
    await setFault(redis, primary, "error_5xx");

    const result = await router.route(
      { model: "default", messages: [{ role: "user", content: "Say exactly: ok" }], maxTokens: 10 },
      "static_priority",
    );

    expect(result.attempts[0]!.provider).toBe(primary);
    expect(result.attempts[0]!.outcome).toBe("error");
    expect(result.attempts[0]!.errorKind).toBe("server_error");

    const successAttempt = result.attempts.find((a) => a.outcome === "success");
    expect(successAttempt).toBeDefined();
    expect(successAttempt!.provider).not.toBe(primary);
    expect(result.response.content.length).toBeGreaterThan(0);
  }, 30000);

  it("throws AllProvidersFailedError when every provider is fault-injected", async () => {
    for (const p of providerPriority) {
      await setFault(redis, p, "error_5xx");
    }

    await expect(
      router.route({ model: "default", messages: [{ role: "user", content: "Say exactly: ok" }], maxTokens: 10 }, "static_priority"),
    ).rejects.toBeInstanceOf(AllProvidersFailedError);
  }, 30000);

  it("caches a response and serves the second identical request from cache (no provider attempts)", async () => {
    const request: UnifiedChatRequest = { model: "default", messages: [{ role: "user", content: "Cache me please" }], maxTokens: 10 };
    const first = await router.route(request, "static_priority");
    expect(first.cacheHit).toBe(false);

    const second = await router.route(request, "static_priority");
    expect(second.cacheHit).toBe(true);
    expect(second.attempts).toHaveLength(0);
    expect(second.response.content).toBe(first.response.content);
  }, 30000);
});
