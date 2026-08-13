import { writeFileSync } from "node:fs";
import { redis } from "../src/redis/client.js";
import { buildProviderRegistry } from "../src/providers/registry.js";
import { CacheStore } from "../src/cache/cacheStore.js";
import { LatencyTracker } from "../src/observability/latencyTracker.js";
import { HealthTracker } from "../src/routing/health.js";
import { StaticPriorityStrategy } from "../src/routing/strategies/staticPriority.js";
import { AllProvidersFailedError, Router } from "../src/routing/router.js";
import { computeCostUsd, getPricing } from "../src/cost/pricing.js";
import { setFault } from "../src/providers/faultInjector.js";
import { providerPriority } from "../src/config/env.js";

const N = 9;

function independentRecompute(provider: string, model: string, promptTokens: number, completionTokens: number): number {
  const pricing = getPricing(provider, model);
  const inCost = (promptTokens * pricing.inputPerMillion) / 1_000_000;
  const outCost = (completionTokens * pricing.outputPerMillion) / 1_000_000;
  return inCost + outCost;
}

async function run() {
  await redis.flushdb();
  const registry = buildProviderRegistry(redis);
  const cacheStore = new CacheStore(redis, 1);
  const latencyTracker = new LatencyTracker(redis);
  const healthTracker = new HealthTracker(redis, 5);
  const strategy = new StaticPriorityStrategy(providerPriority);
  const router = new Router(registry, cacheStore, latencyTracker, healthTracker, { static_priority: strategy });

  const rows: {
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    gatewayCostUsd: number;
    recomputedCostUsd: number;
    absDiff: number;
  }[] = [];

  const available = providerPriority.filter((p) => registry.has(p));
  const skipped: { attempt: number; target: string; reason: string }[] = [];

  for (let i = 0; i < N; i++) {
    const target = available[i % available.length]!;
    for (const p of available) {
      await setFault(redis, p, p === target ? "clear" : "error_5xx");
    }

    try {
      const result = await router.route(
        { model: "default", messages: [{ role: "user", content: `Cost accuracy check #${i}: name a random animal.` }], maxTokens: 15 },
        "static_priority",
      );
      const { provider, model, usage } = result.response;
      const gatewayCostUsd = computeCostUsd(provider, model, usage);
      const recomputedCostUsd = independentRecompute(provider, model, usage.promptTokens, usage.completionTokens);
      rows.push({
        provider,
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        gatewayCostUsd,
        recomputedCostUsd,
        absDiff: Math.abs(gatewayCostUsd - recomputedCostUsd),
      });
    } catch (err) {
      const reason = err instanceof AllProvidersFailedError ? err.message : String(err);
      skipped.push({ attempt: i, target, reason });
      console.warn(`Attempt #${i} (target=${target}) skipped: ${reason}`);
    }
  }

  for (const p of available) {
    await setFault(redis, p, "clear");
  }

  const maxAbsDiff = rows.length > 0 ? Math.max(...rows.map((r) => r.absDiff)) : 0;

  const report = {
    measuredAt: new Date().toISOString(),
    requestCount: N,
    completedCount: rows.length,
    skipped,
    rows,
    maxAbsDiffUsd: maxAbsDiff,
    tolerancePassed: maxAbsDiff < 1e-9,
    scope: "Validates gateway pricing arithmetic against provider-reported token usage, not against real provider billing invoices.",
  };

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(new URL("./results/cost-accuracy.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(`\nMax absolute cost diff across ${rows.length}/${N} completed live requests: $${maxAbsDiff} (${skipped.length} skipped due to real upstream errors)`);

  await redis.quit();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
