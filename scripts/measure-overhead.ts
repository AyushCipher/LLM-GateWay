import { writeFileSync } from "node:fs";
import { redis } from "../src/redis/client.js";
import { buildProviderRegistry } from "../src/providers/registry.js";
import { CacheStore } from "../src/cache/cacheStore.js";
import { LatencyTracker } from "../src/observability/latencyTracker.js";
import { HealthTracker } from "../src/routing/health.js";
import { StaticPriorityStrategy } from "../src/routing/strategies/staticPriority.js";
import { Router } from "../src/routing/router.js";
import { providerPriority } from "../src/config/env.js";

const N = 15;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), avg: samples.reduce((a, b) => a + b, 0) / samples.length };
}

async function run() {
  await redis.flushdb();
  const registry = buildProviderRegistry(redis);
  const primary = providerPriority.find((p) => registry.has(p))!;
  const adapter = registry.get(primary)!;

  const cacheStore = new CacheStore(redis, 1);
  const latencyTracker = new LatencyTracker(redis);
  const healthTracker = new HealthTracker(redis, 5);
  const strategy = new StaticPriorityStrategy(providerPriority);
  const router = new Router(registry, cacheStore, latencyTracker, healthTracker, { static_priority: strategy });

  const directSamples: number[] = [];
  const gatewaySamples: number[] = [];

  for (let i = 0; i < N; i++) {
    const directStart = Date.now();
    await adapter.chat({ model: "default", messages: [{ role: "user", content: `Overhead direct #${i}: one word answer, name a color.` }], maxTokens: 10 }, AbortSignal.timeout(20000));
    directSamples.push(Date.now() - directStart);

    const gatewayStart = Date.now();
    await router.route(
      { model: "default", messages: [{ role: "user", content: `Overhead gateway #${i}: one word answer, name a color.` }], maxTokens: 10 },
      "static_priority",
    );
    gatewaySamples.push(Date.now() - gatewayStart);
  }

  const direct = summarize(directSamples);
  const gateway = summarize(gatewaySamples);

  const report = {
    measuredAt: new Date().toISOString(),
    provider: primary,
    sampleCount: N,
    direct: { ...direct, samples: directSamples },
    gateway: { ...gateway, samples: gatewaySamples },
    overheadMs: { p50: gateway.p50 - direct.p50, p95: gateway.p95 - direct.p95, avg: gateway.avg - direct.avg },
    scope: "Local machine, real internet path to the provider, synthetic single-request-at-a-time measurement — not a production traffic pattern.",
  };

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(new URL("./results/overhead.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(`\nGateway overhead vs direct ${primary} call — p50: ${report.overheadMs.p50}ms, p95: ${report.overheadMs.p95}ms, avg: ${report.overheadMs.avg.toFixed(1)}ms`);

  await redis.quit();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
