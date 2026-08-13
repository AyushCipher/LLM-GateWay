import { ProviderAdapter, ProviderError, UnifiedChatRequest, UnifiedChatResponse } from "../providers/types.js";
import { CacheStore } from "../cache/cacheStore.js";
import { LatencyTracker } from "../observability/latencyTracker.js";
import { HealthTracker } from "./health.js";
import { RoutingStrategy } from "./strategies/types.js";
import { traceLog, traceWarn } from "../observability/tracing.js";
import { fallbackTotal, providerCallsTotal, providerLatencyHistogram } from "../observability/metrics.js";

const PROVIDER_TIMEOUT_MS = 20_000;

export interface RouteAttempt {
  provider: string;
  outcome: "success" | "error";
  latencyMs: number;
  errorKind?: string;
  errorMessage?: string;
}

export interface RouteResult {
  response: UnifiedChatResponse;
  cacheHit: boolean;
  attempts: RouteAttempt[];
  strategyUsed: string;
  totalLatencyMs: number;
}

export class AllProvidersFailedError extends Error {
  constructor(
    public readonly attempts: RouteAttempt[],
    public readonly cause?: unknown,
  ) {
    super(`All providers failed after ${attempts.length} attempt(s): ${attempts.map((a) => `${a.provider}(${a.errorKind})`).join(", ")}`);
    this.name = "AllProvidersFailedError";
  }
}

export class Router {
  constructor(
    private readonly registry: Map<string, ProviderAdapter>,
    private readonly cacheStore: CacheStore,
    private readonly latencyTracker: LatencyTracker,
    private readonly healthTracker: HealthTracker,
    private readonly strategies: Record<string, RoutingStrategy>,
  ) {}

  async route(request: UnifiedChatRequest, strategyName: string): Promise<RouteResult> {
    const start = Date.now();

    const cached = await this.cacheStore.get(request);
    if (cached) {
      traceLog("cache_hit", { model: request.model });
      return { response: cached, cacheHit: true, attempts: [], strategyUsed: strategyName, totalLatencyMs: Date.now() - start };
    }
    traceLog("cache_miss", { model: request.model });

    const strategy = this.strategies[strategyName];
    if (!strategy) {
      throw new Error(`Unknown routing strategy: ${strategyName}`);
    }

    const available = [...this.registry.keys()];
    const ranked = await strategy.orderProviders(available);
    const unhealthyFlags = await Promise.all(ranked.map((p) => this.healthTracker.isUnhealthy(p)));
    const ordered = [
      ...ranked.filter((_, i) => !unhealthyFlags[i]),
      ...ranked.filter((_, i) => unhealthyFlags[i]),
    ];

    traceLog("routing_decision", { strategy: strategyName, order: ordered });

    const attempts: RouteAttempt[] = [];
    let lastError: unknown;

    for (let i = 0; i < ordered.length; i++) {
      const providerName = ordered[i]!;
      const adapter = this.registry.get(providerName)!;
      const attemptStart = Date.now();

      try {
        const response = await adapter.chat(request, AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
        const latencyMs = Date.now() - attemptStart;

        attempts.push({ provider: providerName, outcome: "success", latencyMs });
        await this.latencyTracker.record(providerName, latencyMs);
        await this.healthTracker.markHealthy(providerName);
        providerCallsTotal.inc({ provider: providerName, outcome: "success" });
        providerLatencyHistogram.observe({ provider: providerName }, latencyMs);

        if (i > 0) {
          const from = ordered[i - 1]!;
          fallbackTotal.inc({ from_provider: from, to_provider: providerName });
          traceLog("fallback_success", { from, to: providerName, attemptCount: attempts.length });
        }

        await this.cacheStore.set(request, response);

        return { response, cacheHit: false, attempts, strategyUsed: strategyName, totalLatencyMs: Date.now() - start };
      } catch (err) {
        const latencyMs = Date.now() - attemptStart;
        const kind = err instanceof ProviderError ? err.kind : "network";
        const message = err instanceof Error ? err.message : String(err);

        attempts.push({ provider: providerName, outcome: "error", latencyMs, errorKind: kind, errorMessage: message });
        await this.healthTracker.markUnhealthy(providerName);
        providerCallsTotal.inc({ provider: providerName, outcome: "error" });
        traceWarn("provider_failed", { provider: providerName, kind, message });

        lastError = err;
      }
    }

    throw new AllProvidersFailedError(attempts, lastError);
  }
}
