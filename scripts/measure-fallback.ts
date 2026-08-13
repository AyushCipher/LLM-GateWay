/**
 * Measures fallback correctness and failover latency overhead against real,
 * live providers. Forces the primary provider (first in PROVIDER_PRIORITY)
 * into a 500 via the fault injector, fires N real requests, and reports
 * how many succeeded via fallback plus the latency delta vs. a normal-path
 * baseline measured immediately before.
 */
import { writeFileSync } from "node:fs";
import { redis } from "../src/redis/client.js";
import { buildProviderRegistry } from "../src/providers/registry.js";
import { CacheStore } from "../src/cache/cacheStore.js";
import { LatencyTracker } from "../src/observability/latencyTracker.js";
import { HealthTracker } from "../src/routing/health.js";
import { StaticPriorityStrategy } from "../src/routing/strategies/staticPriority.js";
import { Router } from "../src/routing/router.js";
import { setFault } from "../src/providers/faultInjector.js";
import { providerPriority } from "../src/config/env.js";

const N = 10;

async function run() {
  await redis.flushdb();
  const registry = buildProviderRegistry(redis);
  const cacheStore = new CacheStore(redis, 1); // effectively-disabled cache so every request is a real call
  const latencyTracker = new LatencyTracker(redis);
  const healthTracker = new HealthTracker(redis, 5);
  const strategy = new StaticPriorityStrategy(providerPriority);
  const router = new Router(registry, cacheStore, latencyTracker, healthTracker, { static_priority: strategy });

  const primary = providerPriority.find((p) => registry.has(p))!;
  console.log(`Primary provider under test: ${primary}`);
  console.log(`Providers configured: ${[...registry.keys()].join(", ")}`);

  // --- Baseline: N requests with no fault, primary path ---
  const baselineLatencies: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = Date.now();
    await router.route(
      { model: "default", messages: [{ role: "user", content: `Baseline request #${i}, reply with a short word.` }], maxTokens: 10 },
      "static_priority",
    );
    baselineLatencies.push(Date.now() - start);
  }
  const baselineAvg = baselineLatencies.reduce((a, b) => a + b, 0) / baselineLatencies.length;

  // --- Fault-injected: force primary to fail, N requests, expect fallback success ---
  await setFault(redis, primary, "error_5xx");

  let successCount = 0;
  const failoverLatencies: number[] = [];
  const outcomes: { attempt: number; succeeded: boolean; provider: string | null; attempts: number; latencyMs: number }[] = [];

  for (let i = 0; i < N; i++) {
    const start = Date.now();
    try {
      const result = await router.route(
        { model: "default", messages: [{ role: "user", content: `Failover request #${i}, reply with a short word.` }], maxTokens: 10 },
        "static_priority",
      );
      const latencyMs = Date.now() - start;
      successCount++;
      failoverLatencies.push(latencyMs);
      outcomes.push({ attempt: i, succeeded: true, provider: result.response.provider, attempts: result.attempts.length, latencyMs });
    } catch (err) {
      outcomes.push({ attempt: i, succeeded: false, provider: null, attempts: 0, latencyMs: Date.now() - start });
      console.error(`Request #${i} failed entirely:`, err);
    }
  }

  await setFault(redis, primary, "clear");

  const failoverAvg = failoverLatencies.reduce((a, b) => a + b, 0) / (failoverLatencies.length || 1);
  const overheadMs = failoverAvg - baselineAvg;

  const report = {
    measuredAt: new Date().toISOString(),
    primaryProvider: primary,
    providersConfigured: [...registry.keys()],
    requestCount: N,
    baseline: { avgLatencyMs: Math.round(baselineAvg), samples: baselineLatencies },
    failover: {
      successCount,
      failureCount: N - successCount,
      avgLatencyMs: Math.round(failoverAvg),
      samples: failoverLatencies,
      outcomes,
    },
    failoverOverheadMs: Math.round(overheadMs),
    note: "Baseline and failover requests use distinct prompts (cache effectively disabled, TTL=1s) so every request is a real provider call, not a cache hit.",
  };

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(new URL("./results/fallback.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(`\n${successCount}/${N} requests succeeded via fallback. Failover overhead vs baseline: ~${Math.round(overheadMs)}ms.`);

  await redis.quit();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
