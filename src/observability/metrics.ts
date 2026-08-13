import { Registry, Counter, Histogram, collectDefaultMetrics } from "prom-client";
import type { Redis } from "ioredis";
import { CacheStore } from "../cache/cacheStore.js";
import { LatencyTracker } from "./latencyTracker.js";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const requestsTotal = new Counter({
  name: "gateway_requests_total",
  help: "Total gateway requests by final status",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const providerCallsTotal = new Counter({
  name: "gateway_provider_calls_total",
  help: "Total provider call attempts by provider and outcome",
  labelNames: ["provider", "outcome"] as const, // outcome: success | error
  registers: [registry],
});

export const fallbackTotal = new Counter({
  name: "gateway_fallback_total",
  help: "Total times routing fell back from one provider to the next",
  labelNames: ["from_provider", "to_provider"] as const,
  registers: [registry],
});

export const providerLatencyHistogram = new Histogram({
  name: "gateway_provider_latency_ms",
  help: "Provider call latency in milliseconds",
  labelNames: ["provider"] as const,
  buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000],
  registers: [registry],
});

export const gatewayLatencyHistogram = new Histogram({
  name: "gateway_request_latency_ms",
  help: "End-to-end gateway request latency in milliseconds",
  labelNames: ["cache_hit"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000],
  registers: [registry],
});

export async function getMetricsText(): Promise<string> {
  return registry.metrics();
}

export interface MetricsJson {
  cache: { hits: number; misses: number; hitRate: number };
  providers: Record<string, { p50: number; p95: number; p99: number; count: number }>;
}

export async function getMetricsJson(redis: Redis, providerNames: string[]): Promise<MetricsJson> {
  const cacheStore = new CacheStore(redis);
  const latencyTracker = new LatencyTracker(redis);

  const [cacheStats, ...providerPercentiles] = await Promise.all([
    cacheStore.stats(),
    ...providerNames.map((p) => latencyTracker.percentiles(p)),
  ]);

  const providers: MetricsJson["providers"] = {};
  providerNames.forEach((name, i) => {
    providers[name] = providerPercentiles[i]!;
  });

  return { cache: cacheStats, providers };
}
