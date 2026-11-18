import { ProviderAdapter, ProviderError, TokenUsage, UnifiedChatRequest, UnifiedChatResponse } from "../providers/types.js";
import { StreamChunk } from "../providers/streamTypes.js";
import { CacheStore } from "../cache/cacheStore.js";
import { SemanticCacheStore, SemanticScope } from "../cache/semanticCache.js";
import { normalizedMaxTokens, normalizedTemperature } from "../cache/keyNormalizer.js";
import { estimateUsage } from "../cost/tokenEstimate.js";
import { LatencyTracker } from "../observability/latencyTracker.js";
import { HealthTracker } from "./health.js";
import { RoutingStrategy } from "./strategies/types.js";
import { traceLog, traceWarn } from "../observability/tracing.js";
import { fallbackTotal, providerCallsTotal, providerLatencyHistogram, semanticCacheTotal } from "../observability/metrics.js";

const PROVIDER_TIMEOUT_MS = 20_000;
/** Max silence allowed between stream chunks (and before the first one). A healthy long stream is never cut off. */
const STREAM_IDLE_TIMEOUT_MS = 20_000;

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
      usageEstimated: boolean;
      cacheHit: boolean;
      cacheType: CacheType;
      attempts: RouteAttempt[];
      strategyUsed: string;
      totalLatencyMs: number;
    }
  /** The upstream died (or went idle) after at least the first chunk; `partial` is what was already sent to the client. */
  | { type: "error"; message: string; attempts: RouteAttempt[]; partial?: PartialStream }
  /** The client went away; upstream has been aborted. */
  | { type: "aborted"; attempts: RouteAttempt[]; partial: PartialStream; totalLatencyMs: number };

export interface PartialStream {
  response: UnifiedChatResponse;
  /** true when the provider reported no usage and token counts were estimated from text length. */
  usageEstimated: boolean;
}

class ClientAbortedError extends Error {
  constructor() {
    super("client disconnected");
    this.name = "ClientAbortedError";
  }
}

/**
 * Await the next chunk, failing if the upstream is silent for `idleMs` or the client aborts. Both abort the
 * upstream controller. Racing (rather than only relying on the signal) also frees us from adapters that ignore it.
 */
async function pullChunk(
  iterator: AsyncGenerator<StreamChunk>,
  controller: AbortController,
  clientSignal: AbortSignal | undefined,
  idleMs: number,
  provider: string,
): Promise<IteratorResult<StreamChunk>> {
  if (clientSignal?.aborted) throw new ClientAbortedError();

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError(provider, "timeout", `${provider} stream idle for more than ${idleMs}ms`));
    }, idleMs);
    onAbort = () => {
      controller.abort();
      reject(new ClientAbortedError());
    };
    clientSignal?.addEventListener("abort", onAbort, { once: true });
  });

  const next = iterator.next();
  next.catch(() => {}); // the loser of the race must not surface as an unhandled rejection
  guard.catch(() => {});
  try {
    return await Promise.race([next, guard]);
  } finally {
    clearTimeout(timer);
    if (onAbort) clientSignal?.removeEventListener("abort", onAbort);
  }
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
    private readonly options: { streamIdleTimeoutMs?: number } = {},
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

  /**
   * The literal model "default" resolves to a different concrete model per provider, so cache entries made under
   * it are scoped to the exact provider:model set this gateway can route to, never shared with another setup.
   */
  private modelScopeFor(request: UnifiedChatRequest): string {
    if (request.model && request.model !== "default") return request.model;
    const chain = [...this.registry.entries()].map(([name, adapter]) => `${name}:${adapter.defaultModel}`).sort();
    return `default@${chain.join(",")}`;
  }

  private semanticScopeFor(request: UnifiedChatRequest): SemanticScope | null {
    if (!request.tenantId) return null; // semantic entries are tenant-owned; never cache without a tenant
    return {
      tenantId: request.tenantId,
      model: this.modelScopeFor(request),
      temperature: normalizedTemperature(request),
      maxTokens: normalizedMaxTokens(request),
    };
  }

  private async checkSemanticCache(request: UnifiedChatRequest): Promise<SemanticCheckResult | null> {
    if (!this.semanticCache) return null;
    const scope = this.semanticScopeFor(request);
    if (!scope) return null;

    let embedding: number[];
    try {
      embedding = await this.semanticCache.embed(promptTextFor(request));
    } catch (err) {
      traceWarn("semantic_cache_embed_failed", { message: err instanceof Error ? err.message : String(err) });
      return null;
    }

    const found = await this.semanticCache.store.findSimilar(scope, embedding);
    if (found) {
      semanticCacheTotal.inc({ outcome: "hit" });
      traceLog("semantic_cache_hit", { similarity: found.similarity });
      return { hit: found.response, embedding };
    }

    semanticCacheTotal.inc({ outcome: "miss" });
    return { hit: null, embedding };
  }

  private async persistToCaches(request: UnifiedChatRequest, response: UnifiedChatResponse, semantic: SemanticCheckResult | null): Promise<void> {
    await this.cacheStore.set(request, response, this.modelScopeFor(request));
    const scope = this.semanticScopeFor(request);
    if (this.semanticCache && semantic && scope) {
      await this.semanticCache.store.store(scope, promptTextFor(request), semantic.embedding, response);
    }
  }

  async route(request: UnifiedChatRequest, strategyName: string): Promise<RouteResult> {
    const start = Date.now();

    const cached = await this.cacheStore.get(request, this.modelScopeFor(request));
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

  async *routeStream(request: UnifiedChatRequest, strategyName: string, clientSignal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const start = Date.now();
    const idleMs = this.options.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
    const promptText = promptTextFor(request);

    const cached = await this.cacheStore.get(request, this.modelScopeFor(request));
    if (cached) {
      traceLog("cache_hit", { model: request.model, streaming: true });
      yield { type: "chunk", delta: cached.content };
      yield {
        type: "done",
        response: cached,
        usageEstimated: false,
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
        usageEstimated: false,
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
      const controller = new AbortController();
      const iterator = adapter.chatStream(request, controller.signal);

      let fullContent = "";
      let finalUsage: TokenUsage | undefined;
      const buildPartial = (): PartialStream => ({
        response: {
          provider: providerName,
          model: resolveModel(adapter, request),
          content: fullContent,
          usage: finalUsage ?? estimateUsage(promptText, fullContent),
          raw: null,
        },
        usageEstimated: finalUsage === undefined,
      });

      try {
        let firstResult: IteratorResult<StreamChunk>;
        try {
          firstResult = await pullChunk(iterator, controller, clientSignal, idleMs, providerName);
        } catch (err) {
          if (err instanceof ClientAbortedError) {
            yield { type: "aborted", attempts, partial: buildPartial(), totalLatencyMs: Date.now() - start };
            return;
          }
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

        try {
          let result = firstResult;
          while (!result.done) {
            const chunk = result.value;
            fullContent += chunk.delta;
            if (chunk.usage) finalUsage = chunk.usage;
            if (chunk.delta) yield { type: "chunk", delta: chunk.delta };
            result = await pullChunk(iterator, controller, clientSignal, idleMs, providerName);
          }
        } catch (err) {
          const latencyMs = Date.now() - attemptStart;
          if (err instanceof ClientAbortedError) {
            attempts.push({ provider: providerName, outcome: "error", latencyMs, errorKind: "client_abort", errorMessage: "client disconnected" });
            traceLog("stream_client_aborted", { provider: providerName, chars: fullContent.length });
            yield { type: "aborted", attempts, partial: buildPartial(), totalLatencyMs: Date.now() - start };
            return;
          }
          const kind = err instanceof ProviderError ? err.kind : "network";
          const message = err instanceof Error ? err.message : String(err);
          attempts.push({ provider: providerName, outcome: "error", latencyMs, errorKind: kind, errorMessage: message });
          await this.healthTracker.markUnhealthy(providerName);
          providerCallsTotal.inc({ provider: providerName, outcome: "error" });
          traceWarn("provider_stream_failed_midstream", { provider: providerName, kind, message });
          yield { type: "error", message: `stream interrupted after partial output: ${message}`, attempts, partial: buildPartial() };
          return;
        }

        const latencyMs = Date.now() - attemptStart;
        attempts.push({ provider: providerName, outcome: "success", latencyMs });
        await this.latencyTracker.record(providerName, latencyMs);
        await this.healthTracker.markHealthy(providerName);
        providerCallsTotal.inc({ provider: providerName, outcome: "success" });
        providerLatencyHistogram.observe({ provider: providerName }, latencyMs);

        const { response, usageEstimated } = buildPartial();

        await this.persistToCaches(request, response, semantic);

        yield {
          type: "done",
          response,
          usageEstimated,
          cacheHit: false,
          cacheType: null,
          attempts,
          strategyUsed: strategyName,
          totalLatencyMs: Date.now() - start,
        };
        return;
      } finally {
        // Runs on success, failure, client abort, and when the consumer stops iterating early: always release upstream.
        controller.abort();
        void iterator.return(undefined).catch(() => {});
      }
    }

    yield {
      type: "error",
      message: `All providers failed before streaming began: ${attempts.map((a) => `${a.provider}(${a.errorKind})`).join(", ")}`,
      attempts,
    };
  }
}
