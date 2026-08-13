import { writeFileSync } from "node:fs";
import { redis } from "../src/redis/client.js";
import { buildProviderRegistry } from "../src/providers/registry.js";
import { CacheStore } from "../src/cache/cacheStore.js";
import { LatencyTracker } from "../src/observability/latencyTracker.js";
import { HealthTracker } from "../src/routing/health.js";
import { StaticPriorityStrategy } from "../src/routing/strategies/staticPriority.js";
import { Router } from "../src/routing/router.js";
import { providerPriority } from "../src/config/env.js";

const REPEATED_POOL = [
  "What is the capital of France?",
  "What is 12 times 12?",
  "Name one primary color.",
  "What is the chemical symbol for water?",
  "How many days are in a week?",
];
const REPEAT_COUNTS = [8, 6, 5, 4, 3];
const NOVEL_COUNT = 12;

function buildWorkload(): string[] {
  const workload: string[] = [];
  REPEATED_POOL.forEach((prompt, i) => {
    for (let n = 0; n < REPEAT_COUNTS[i]!; n++) workload.push(prompt);
  });
  for (let i = 0; i < NOVEL_COUNT; i++) {
    workload.push(`Novel one-off prompt number ${i}: give a one-word answer to 2+${i}.`);
  }
  for (let i = workload.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [workload[i], workload[j]] = [workload[j]!, workload[i]!];
  }
  return workload;
}

async function run() {
  await redis.flushdb();
  const registry = buildProviderRegistry(redis);
  const cacheStore = new CacheStore(redis, 300);
  const latencyTracker = new LatencyTracker(redis);
  const healthTracker = new HealthTracker(redis, 5);
  const strategy = new StaticPriorityStrategy(providerPriority);
  const router = new Router(registry, cacheStore, latencyTracker, healthTracker, { static_priority: strategy });

  const workload = buildWorkload();
  const expectedHits = REPEAT_COUNTS.reduce((sum, c) => sum + (c - 1), 0);

  let hits = 0;
  let misses = 0;
  const perRequest: { prompt: string; cacheHit: boolean }[] = [];

  for (const prompt of workload) {
    const result = await router.route({ model: "default", messages: [{ role: "user", content: prompt }], maxTokens: 10 }, "static_priority");
    if (result.cacheHit) hits++;
    else misses++;
    perRequest.push({ prompt, cacheHit: result.cacheHit });
  }

  const hitRate = hits / workload.length;
  const stats = await cacheStore.stats();

  const report = {
    measuredAt: new Date().toISOString(),
    workloadSize: workload.length,
    distinctPrompts: REPEATED_POOL.length + NOVEL_COUNT,
    repeatedPoolSize: REPEATED_POOL.length,
    repeatCounts: REPEAT_COUNTS,
    novelPromptCount: NOVEL_COUNT,
    expectedHits,
    actualHits: hits,
    actualMisses: misses,
    hitRate,
    cacheStoreStats: stats,
    perRequest,
  };

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(new URL("./results/cache-hitrate.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(`\nActual cache hit-rate: ${(hitRate * 100).toFixed(1)}% (${hits}/${workload.length}), expected ${expectedHits}/${workload.length} by construction.`);

  await redis.quit();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
