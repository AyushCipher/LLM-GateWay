import { ProviderAdapter, ProviderError, TokenUsage, UnifiedChatRequest, UnifiedChatResponse } from "../providers/types.js";
import { StreamChunk } from "../providers/streamTypes.js";
import { CacheStore } from "../cache/cacheStore.js";
import { SemanticCacheStore } from "../cache/semanticCache.js";
import { LatencyTracker } from "../observability/latencyTracker.js";
import { HealthTracker } from "./health.js";
import { RoutingStrategy } from "./strategies/types.js";
import { traceLog, traceWarn } from "../observability/tracing.js";
import { fallbackTotal, providerCallsTotal, providerLatencyHistogram, semanticCacheTotal } from "../observability/metrics.js";

const PROVIDER_TIMEOUT_MS = 20_000;

export type CacheType = "exact" | "semantic" | null;

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
  cacheType: CacheType;
  attempts: RouteAttempt[];
  strategyUsed: string;
  totalLatencyMs: number;
}

export type StreamEvent =
  | { type: "chunk"; delta: string }
  | {
      type: "done";
      response: UnifiedChatResponse;
      cacheHit: boolean;
      cacheType: CacheType;
      attempts: RouteAttempt[];
      strategyUsed: string;
      totalLatencyMs: number;
    }
  | { type: "error"; message: string; attempts: RouteAttempt[] };

export class AllProvidersFailedError extends Error {
  constructor(
    public readonly attempts: RouteAttempt[],
    public readonly cause?: unknown,
  ) {
    super(`All providers failed after ${attempts.length} attempt(s): ${attempts.map((a) => `${a.provider}(${a.errorKind})`).join(", ")}`);
    this.name = "AllProvidersFailedError";
  }
}

export interface SemanticCacheDeps {
  store: SemanticCacheStore;
  embed: (text: string) => Promise<number[]>;
}

interface SemanticCheckResult {
  hit: UnifiedChatResponse | null;
  embedding: number[];
}

function promptTextFor(request: UnifiedChatRequest): string {
  return request.messages.map((m) => m.content).join("\n");
}

function resolveModel(adapter: ProviderAdapter, request: UnifiedChatRequest): string {
  return request.model === "default" || !request.model ? adapter.defaultModel : request.model;
}

export class Router {
  constructor(
    private readonly registry: Map<string, ProviderAdapter>,
    private readonly cacheStore: CacheStore,
    private readonly latencyTracker: LatencyTracker,
    private readonly healthTracker: HealthTracker,
    private readonly strategies: Record<string, RoutingStrategy>,
    private readonly semanticCache?: SemanticCacheDeps,
  ) {}

  private async rankProviders(strategyName: string): Promise<string[]> {
    const strategy = this.strategies[strategyName];
    if (!strategy) {
      throw new Error(`Unknown routing strategy: ${strategyName}`);
    }
    const available = [...this.registry.keys()];
    const ranked = await strategy.orderProviders(available);
    const unhealthyFlags = await Promise.all(ranked.map((p) => this.healthTracker.isUnhealthy(p)));
    return [...ranked.filter((_, i) => !unhealthyFlags[i]), ...ranked.filter((_, i) => unhealthyFlags[i])];
  }

  private async checkSemanticCache(request: UnifiedChatRequest): Promise<SemanticCheckResult | null> {
    if (!this.semanticCache) return null;

    let embedding: number[];
    try {
      embedding = await this.semanticCache.embed(promptTextFor(request));
    } catch (err) {
      traceWarn("semantic_cache_embed_failed", { message: err instanceof Error ? err.message : String(err) });
      return null;
    }

    const found = await this.semanticCache.store.findSimilar(request.model, embedding);
    if (found) {
      semanticCacheTotal.inc({ outcome: "hit" });
      traceLog("semantic_cache_hit", { similarity: found.similarity });
      return { hit: found.response, embedding };
    }

    semanticCacheTotal.inc({ outcome: "miss" });
    return { hit: null, embedding };
  }

  private async persistToCaches(request: UnifiedChatRequest, response: UnifiedChatResponse, semantic: SemanticCheckResult | null): Promise<void> {
    await this.cacheStore.set(request, response);
    if (this.semanticCache && semantic) {
      await this.semanticCache.store.store(request.model, promptTextFor(request), semantic.embedding, response);
    }
  }

  async route(request: UnifiedChatRequest, strategyName: string): Promise<RouteResult> {
    const start = Date.now();

    const cached = await this.cacheStore.get(request);
    if (cached) {
      traceLog("cache_hit", { model: request.model });
      return { response: cached, cacheHit: true, cacheType: "exact", attempts: [], strategyUsed: strategyName, totalLatencyMs: Date.now() - start };
    }
    traceLog("cache_miss", { model: request.model });

    const semantic = await this.checkSemanticCache(request);
    if (semantic?.hit) {
      return {
        response: semantic.hit,
        cacheHit: true,
        cacheType: "semantic",
        attempts: [],
        strategyUsed: strategyName,
        totalLatencyMs: Date.now() - start,
      };
    }

    const ordered = await this.rankProviders(strategyName);
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

        await this.persistToCaches(request, response, semantic);

        return { response, cacheHit: false, cacheType: null, attempts, strategyUsed: strategyName, totalLatencyMs: Date.now() - start };
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

  async *routeStream(request: UnifiedChatRequest, strategyName: string): AsyncGenerator<StreamEvent> {
    const start = Date.now();

    const cached = await this.cacheStore.get(request);
    if (cached) {
      traceLog("cache_hit", { model: request.model, streaming: true });
      yield { type: "chunk", delta: cached.content };
      yield {
        type: "done",
        response: cached,
        cacheHit: true,
        cacheType: "exact",
        attempts: [],
        strategyUsed: strategyName,
        totalLatencyMs: Date.now() - start,
      };
      return;
    }

    const semantic = await this.checkSemanticCache(request);
    if (semantic?.hit) {
      yield { type: "chunk", delta: semantic.hit.content };
      yield {
        type: "done",
        response: semantic.hit,
        cacheHit: true,
        cacheType: "semantic",
        attempts: [],
        strategyUsed: strategyName,
        totalLatencyMs: Date.now() - start,
      };
      return;
    }

    const ordered = await this.rankProviders(strategyName);
    traceLog("routing_decision", { strategy: strategyName, order: ordered, streaming: true });

    const attempts: RouteAttempt[] = [];

    for (let i = 0; i < ordered.length; i++) {
      const providerName = ordered[i]!;
      const adapter = this.registry.get(providerName)!;
      const attemptStart = Date.now();
      const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);

      const iterator = adapter.chatStream(request, signal);
      let firstResult: IteratorResult<StreamChunk>;
      try {
        firstResult = await iterator.next();
      } catch (err) {
        const latencyMs = Date.now() - attemptStart;
        const kind = err instanceof ProviderError ? err.kind : "network";
        const message = err instanceof Error ? err.message : String(err);
        attempts.push({ provider: providerName, outcome: "error", latencyMs, errorKind: kind, errorMessage: message });
        await this.healthTracker.markUnhealthy(providerName);
        providerCallsTotal.inc({ provider: providerName, outcome: "error" });
        traceWarn("provider_failed", { provider: providerName, kind, message, streaming: true });
        continue;
      }

      if (i > 0) {
        const from = ordered[i - 1]!;
        fallbackTotal.inc({ from_provider: from, to_provider: providerName });
        traceLog("fallback_success", { from, to: providerName, attemptCount: attempts.length + 1, streaming: true });
      }

      let fullContent = "";
      let finalUsage: TokenUsage | undefined;

      try {
        let result = firstResult;
        while (!result.done) {
          const chunk = result.value;
          fullContent += chunk.delta;
          if (chunk.usage) finalUsage = chunk.usage;
          if (chunk.delta) yield { type: "chunk", delta: chunk.delta };
          result = await iterator.next();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        attempts.push({
          provider: providerName,
          outcome: "error",
          latencyMs: Date.now() - attemptStart,
          errorKind: "network",
          errorMessage: message,
        });
        traceWarn("provider_stream_failed_midstream", { provider: providerName, message });
        yield { type: "error", message: `stream interrupted after partial output: ${message}`, attempts };
        return;
      }

      const latencyMs = Date.now() - attemptStart;
      attempts.push({ provider: providerName, outcome: "success", latencyMs });
      await this.latencyTracker.record(providerName, latencyMs);
      await this.healthTracker.markHealthy(providerName);
      providerCallsTotal.inc({ provider: providerName, outcome: "success" });
      providerLatencyHistogram.observe({ provider: providerName }, latencyMs);

      const response: UnifiedChatResponse = {
        provider: providerName,
        model: resolveModel(adapter, request),
        content: fullContent,
        usage: finalUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        raw: null,
      };

      await this.persistToCaches(request, response, semantic);

      yield {
        type: "done",
        response,
        cacheHit: false,
        cacheType: null,
        attempts,
        strategyUsed: strategyName,
        totalLatencyMs: Date.now() - start,
      };
      return;
    }

    yield {
      type: "error",
      message: `All providers failed before streaming began: ${attempts.map((a) => `${a.provider}(${a.errorKind})`).join(", ")}`,
      attempts,
    };
  }
}
