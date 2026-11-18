// Requires Postgres + pgvector (docker compose up -d) with `npm run migrate` applied. Uses synthetic vectors,
// so no embedding API key or network access is needed.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createTestPool } from "./testDb.js";
import { SemanticCacheStore, SemanticScope } from "../../src/cache/semanticCache.js";
import { UnifiedChatResponse } from "../../src/providers/types.js";

let pool: pg.Pool;
let store: SemanticCacheStore;
let model: string;
let scopeA: SemanticScope;

function vec(seed: number): number[] {
  const v = Array.from({ length: 768 }, (_, i) => Math.sin(seed * (i + 1)));
  return v;
}

function resp(content: string): UnifiedChatResponse {
  return { provider: "test", model: "m", content, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, raw: {} };
}

describe("SemanticCacheStore tenant isolation (real pgvector, synthetic vectors)", () => {
  beforeAll(() => {
    pool = createTestPool();
  });

  beforeEach(() => {
    model = `test-model-${randomUUID()}`;
    scopeA = { tenantId: randomUUID(), model, temperature: 0.7, maxTokens: 512 };
    store = new SemanticCacheStore(pool, 60, 0.8);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM semantic_cache WHERE model LIKE 'test-model-%'");
    await pool.end();
  });

  it("serves the owner an identical-vector entry", async () => {
    await store.store(scopeA, "p", vec(1), resp("A's answer"));
    const hit = await store.findSimilar(scopeA, vec(1));
    expect(hit?.response.content).toBe("A's answer");
  });

  it("never serves tenant A's entry to tenant B, even with an identical embedding and model", async () => {
    await store.store(scopeA, "p", vec(1), resp("A's secret"));
    const hit = await store.findSimilar({ ...scopeA, tenantId: randomUUID() }, vec(1));
    expect(hit).toBeNull();
  });

  it("does not match across different temperature", async () => {
    await store.store(scopeA, "p", vec(1), resp("warm"));
    expect(await store.findSimilar({ ...scopeA, temperature: 0.0 }, vec(1))).toBeNull();
  });

  it("does not match across different maxTokens", async () => {
    await store.store(scopeA, "p", vec(1), resp("short"));
    expect(await store.findSimilar({ ...scopeA, maxTokens: 5 }, vec(1))).toBeNull();
  });

  it("sweepExpired removes expired rows and keeps live ones", async () => {
    await new SemanticCacheStore(pool, 1, 0.8).store(scopeA, "old", vec(2), resp("old"));
    await store.store({ ...scopeA, maxTokens: 7 }, "fresh", vec(3), resp("fresh"));
    await new Promise((r) => setTimeout(r, 1500));

    const removed = await store.sweepExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query("SELECT prompt_text FROM semantic_cache WHERE model = $1", [model]);
    expect(rows.map((r) => r.prompt_text)).toEqual(["fresh"]);
  }, 10000);

  it("has the composite tenant lookup index", async () => {
    const { rows } = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_semantic_cache_tenant_lookup'");
    expect(rows).toHaveLength(1);
  });
});
