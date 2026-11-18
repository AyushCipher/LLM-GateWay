import type { Redis } from "ioredis";
import { CacheStore } from "../../src/cache/cacheStore.js";
import { LatencyTracker } from "../../src/observability/latencyTracker.js";
import { HealthTracker } from "../../src/routing/health.js";
import { Router } from "../../src/routing/router.js";
import { StreamChunk } from "../../src/providers/streamTypes.js";
import { ProviderAdapter, UnifiedChatRequest, UnifiedChatResponse } from "../../src/providers/types.js";

/** Minimal in-memory stand-in for the handful of Redis commands CacheStore uses. TTLs are not simulated. */
export function fakeRedis(): Redis {
  const data = new Map<string, string>();
  return {
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => {
      data.set(k, v);
      return "OK";
    },
    incr: async (k: string) => {
      const n = Number(data.get(k) ?? 0) + 1;
      data.set(k, String(n));
      return n;
    },
    del: async (...keys: string[]) => keys.reduce((n, k) => n + (data.delete(k) ? 1 : 0), 0),
  } as unknown as Redis;
}

export type StreamFactory = (signal: AbortSignal, request: UnifiedChatRequest) => AsyncGenerator<StreamChunk>;

export class FakeAdapter implements ProviderAdapter {
  chatCalls = 0;
  lastSignal?: AbortSignal;
  constructor(
    readonly name: string,
    readonly defaultModel: string,
    private readonly stream: StreamFactory = async function* () {},
  ) {}

  async chat(_request: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    this.chatCalls++;
    return {
      provider: this.name,
      model: this.defaultModel,
      content: `answer from ${this.name}`,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      raw: null,
    };
  }

  chatStream(request: UnifiedChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    this.lastSignal = signal;
    return this.stream(signal, request);
  }
}

/** Rejects when `signal` aborts, never resolves: models an upstream that has gone silent. */
export function waitForever(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function buildRouter(adapters: FakeAdapter[], opts: { streamIdleTimeoutMs?: number; redis?: Redis } = {}): Router {
  const registry = new Map<string, ProviderAdapter>(adapters.map((a) => [a.name, a]));
  const health = {
    isUnhealthy: async () => false,
    markHealthy: async () => {},
    markUnhealthy: async () => {},
  } as unknown as HealthTracker;
  const latency = { record: async () => {} } as unknown as LatencyTracker;
  const strategy = { name: "static_priority", orderProviders: async (a: string[]) => a };
  return new Router(
    registry,
    new CacheStore(opts.redis ?? fakeRedis(), 60),
    latency,
    health,
    { static_priority: strategy },
    undefined,
    { streamIdleTimeoutMs: opts.streamIdleTimeoutMs },
  );
}
