import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestPool, insertTestApiKey } from "./testDb.js";
import { CostTracker } from "../../src/cost/costTracker.js";

let pool: pg.Pool;
let tracker: CostTracker;
let apiKeyId: string;

describe("CostTracker (real Postgres)", () => {
  beforeEach(async () => {
    pool = createTestPool();
    tracker = new CostTracker(pool);
    apiKeyId = await insertTestApiKey(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records a request and reflects it in usage totals", async () => {
    await tracker.recordRequest({
      traceId: "trace-1",
      apiKeyId,
      provider: "groq",
      model: "llama-3.1-8b-instant",
      routingStrategy: "static_priority",
      attemptedProviders: ["groq"],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      costUsd: 0.000009,
      cacheHit: false,
      latencyMs: 420,
      status: "success",
    });

    const usage = await tracker.getUsage(apiKeyId, 24);
    expect(usage.totalRequests).toBe(1);
    expect(usage.totalPromptTokens).toBe(100);
    expect(usage.totalCompletionTokens).toBe(50);
    expect(usage.totalCostUsd).toBeCloseTo(0.000009, 9);
    expect(usage.byProvider).toEqual([{ provider: "groq", requests: 1, costUsd: expect.closeTo(0.000009, 9) }]);
  });

  it("aggregates multiple requests across providers", async () => {
    await tracker.recordRequest({
      traceId: "trace-2",
      apiKeyId,
      provider: "groq",
      model: "llama-3.1-8b-instant",
      routingStrategy: "static_priority",
      attemptedProviders: ["groq"],
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      costUsd: 0.000001,
      cacheHit: false,
      latencyMs: 100,
      status: "success",
    });
    await tracker.recordRequest({
      traceId: "trace-3",
      apiKeyId,
      provider: "gemini",
      model: "gemini-flash-lite-latest",
      routingStrategy: "static_priority",
      attemptedProviders: ["groq", "gemini"],
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      costUsd: 0.000028,
      cacheHit: false,
      latencyMs: 200,
      status: "success",
    });
    await tracker.recordRequest({
      traceId: "trace-4",
      apiKeyId,
      provider: null,
      model: null,
      routingStrategy: "static_priority",
      attemptedProviders: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      costUsd: 0,
      cacheHit: true,
      latencyMs: 5,
      status: "success",
    });

    const usage = await tracker.getUsage(apiKeyId, 24);
    expect(usage.totalRequests).toBe(3);
    expect(usage.cacheHits).toBe(1);
    expect(usage.byProvider.map((p) => p.provider).sort()).toEqual(["gemini", "groq"]);
  });

  it("excludes requests outside the requested time window", async () => {
    await pool.query(
      `INSERT INTO requests
        (trace_id, api_key_id, provider, model, routing_strategy, attempted_providers,
         prompt_tokens, completion_tokens, total_tokens, cost_usd, cache_hit, latency_ms, status, created_at)
       VALUES ('trace-old', $1, 'groq', 'llama-3.1-8b-instant', 'static_priority', '{}', 10, 10, 20, 0.001, false, 100, 'success', now() - interval '48 hours')`,
      [apiKeyId],
    );

    const usage = await tracker.getUsage(apiKeyId, 24);
    expect(usage.totalRequests).toBe(0);
  });
});
