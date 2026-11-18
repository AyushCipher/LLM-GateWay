import { describe, expect, it } from "vitest";
import type pg from "pg";
import { CacheStore } from "../../src/cache/cacheStore.js";
import { cacheKeyFor } from "../../src/cache/keyNormalizer.js";
import { SemanticCacheStore, SemanticScope } from "../../src/cache/semanticCache.js";
import { UnifiedChatRequest, UnifiedChatResponse } from "../../src/providers/types.js";
import { FakeAdapter, buildRouter, fakeRedis } from "../helpers/fakes.js";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const base: UnifiedChatRequest = { model: "default", messages: [{ role: "user", content: "What is our refund policy?" }], temperature: 0.7, maxTokens: 512 };

const response: UnifiedChatResponse = {
  provider: "groq",
  model: "llama-3.1-8b-instant",
  content: "tenant A's private answer",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  raw: null,
};

describe("exact cache tenant isolation", () => {
  it("different tenants get different keys for an otherwise identical request", () => {
    expect(cacheKeyFor({ ...base, tenantId: TENANT_A })).not.toBe(cacheKeyFor({ ...base, tenantId: TENANT_B }));
    expect(cacheKeyFor({ ...base, tenantId: TENANT_A })).toBe(cacheKeyFor({ ...base, tenantId: TENANT_A }));
  });

  it("tenant B cannot read tenant A's cached response", async () => {
    const store = new CacheStore(fakeRedis(), 60);
    await store.set({ ...base, tenantId: TENANT_A }, response);

    expect(await store.get({ ...base, tenantId: TENANT_A })).toEqual(response);
    expect(await store.get({ ...base, tenantId: TENANT_B })).toBeNull();
    expect(await store.get({ ...base })).toBeNull(); // the anonymous namespace is separate from any tenant
  });

  it("'default' is scoped by provider:model set and not shared across provider setups", async () => {
    const store = new CacheStore(fakeRedis(), 60);
    const req = { ...base, tenantId: TENANT_A };
    await store.set(req, response, "default@groq:llama-3.1-8b-instant");
    expect(await store.get(req, "default@gemini:gemini-flash-lite-latest")).toBeNull();
    expect(await store.get(req, "default@groq:llama-3.1-8b-instant")).toEqual(response);
  });

  it("Router: tenant B does not receive tenant A's cached answer end to end", async () => {
    const adapter = new FakeAdapter("groq", "llama-3.1-8b-instant");
    const router = buildRouter([adapter]);

    const first = await router.route({ ...base, tenantId: TENANT_A }, "static_priority");
    expect(first.cacheHit).toBe(false);
    const sameTenant = await router.route({ ...base, tenantId: TENANT_A }, "static_priority");
    expect(sameTenant.cacheHit).toBe(true);

    const otherTenant = await router.route({ ...base, tenantId: TENANT_B }, "static_priority");
    expect(otherTenant.cacheHit).toBe(false);
    expect(adapter.chatCalls).toBe(2);
  });
});

describe("SemanticCacheStore query scoping (fake pool)", () => {
  function fakePool() {
    const calls: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 3 };
      },
    } as unknown as pg.Pool;
    return { pool, calls };
  }
  const scope: SemanticScope = { tenantId: TENANT_A, model: "m", temperature: 0.2, maxTokens: 64 };

  it("filters lookups by tenant, model, temperature and max_tokens", async () => {
    const { pool, calls } = fakePool();
    await new SemanticCacheStore(pool, 60, 0.8).findSimilar(scope, [0.1, 0.2]);
    const { sql, params } = calls[0]!;
    expect(sql).toMatch(/api_key_id = \$2/);
    expect(sql).toMatch(/model = \$3/);
    expect(sql).toMatch(/temperature = \$4/);
    expect(sql).toMatch(/max_tokens = \$5/);
    expect(params.slice(1)).toEqual([TENANT_A, "m", 0.2, 64]);
  });

  it("writes the tenant and sampling params with every row", async () => {
    const { pool, calls } = fakePool();
    await new SemanticCacheStore(pool, 60, 0.8).store(scope, "p", [0.1], response);
    expect(calls[0]!.sql).toMatch(/api_key_id, model, temperature, max_tokens/);
    expect(calls[0]!.params.slice(0, 4)).toEqual([TENANT_A, "m", 0.2, 64]);
  });

  it("sweepExpired deletes expired rows and reports the count", async () => {
    const { pool, calls } = fakePool();
    expect(await new SemanticCacheStore(pool, 60, 0.8).sweepExpired()).toBe(3);
    expect(calls[0]!.sql).toMatch(/DELETE FROM semantic_cache WHERE expires_at <= now\(\)/);
  });

  it("startSweeper runs periodically and can be stopped", async () => {
    const { pool, calls } = fakePool();
    const stop = new SemanticCacheStore(pool, 60, 0.8).startSweeper(20);
    await new Promise((r) => setTimeout(r, 90));
    stop();
    const seen = calls.length;
    expect(seen).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.length).toBe(seen);
  });

  it("Router never touches the semantic cache without a tenant", async () => {
    let touched = false;
    const router = buildRouter([new FakeAdapter("groq", "llama-3.1-8b-instant")]);
    // swap in semantic deps through the public constructor path
    const { Router } = await import("../../src/routing/router.js");
    const withSemantic = new Router(
      (router as unknown as { registry: never }).registry,
      (router as unknown as { cacheStore: never }).cacheStore,
      (router as unknown as { latencyTracker: never }).latencyTracker,
      (router as unknown as { healthTracker: never }).healthTracker,
      (router as unknown as { strategies: never }).strategies,
      {
        store: { findSimilar: async () => ((touched = true), null), store: async () => void (touched = true) } as unknown as SemanticCacheStore,
        embed: async () => [0.1],
      },
    );
    await withSemantic.route({ ...base }, "static_priority"); // no tenantId
    expect(touched).toBe(false);
  });
});
