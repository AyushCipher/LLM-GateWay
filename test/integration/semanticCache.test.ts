import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createTestPool } from "./testDb.js";
import { SemanticCacheStore, SemanticScope } from "../../src/cache/semanticCache.js";
import { embedText } from "../../src/providers/embeddings.js";
import { env } from "../../src/config/env.js";
import { UnifiedChatResponse } from "../../src/providers/types.js";

const liveEmbeddingsAvailable = Boolean(env.GEMINI_API_KEY);

let pool: pg.Pool;
let store: SemanticCacheStore;
let testModel: string;
let tenantA: string;
let scope: SemanticScope;

function dummyResponse(content: string): UnifiedChatResponse {
  return {
    provider: "test",
    model: "test-model",
    content,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    raw: {},
  };
}

function embed(text: string): Promise<number[]> {
  return embedText(env.GEMINI_API_KEY, env.EMBEDDING_MODEL, text);
}

describe.skipIf(!liveEmbeddingsAvailable)("SemanticCacheStore (real Gemini embeddings + real pgvector)", () => {
  beforeEach(() => {
    pool = createTestPool();
    testModel = `test-model-${randomUUID()}`;
    tenantA = randomUUID();
    scope = { tenantId: tenantA, model: testModel, temperature: 0.7, maxTokens: 512 };
    store = new SemanticCacheStore(pool, 60, 0.8);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM semantic_cache WHERE model LIKE 'test-model-%'");
    await pool.end();
  });

  it("returns null when nothing is cached for this model", async () => {
    const embedding = await embed("What is the capital of France?");
    const hit = await store.findSimilar(scope, embedding);
    expect(hit).toBeNull();
  });

  it("finds a differently-worded paraphrase above the similarity threshold", async () => {
    const originalEmbedding = await embed("What is the capital of France?");
    await store.store(scope, "What is the capital of France?", originalEmbedding, dummyResponse("Paris"));

    const paraphraseEmbedding = await embed("Tell me France's capital city.");
    const hit = await store.findSimilar(scope, paraphraseEmbedding);

    expect(hit).not.toBeNull();
    expect(hit!.response.content).toBe("Paris");
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.8);
  }, 20000);

  it("does not match an unrelated prompt", async () => {
    const originalEmbedding = await embed("What is the capital of France?");
    await store.store(scope, "What is the capital of France?", originalEmbedding, dummyResponse("Paris"));

    const unrelatedEmbedding = await embed("What's 12 times 12?");
    const hit = await store.findSimilar(scope, unrelatedEmbedding);

    expect(hit).toBeNull();
  }, 20000);

  it("never matches across different models", async () => {
    const embedding = await embed("What is the capital of France?");
    await store.store(scope, "What is the capital of France?", embedding, dummyResponse("Paris"));

    const hit = await store.findSimilar({ ...scope, model: `${testModel}-other` }, embedding);
    expect(hit).toBeNull();
  });

  it("excludes entries past their TTL", async () => {
    const shortTtlStore = new SemanticCacheStore(pool, 1, 0.8);
    const embedding = await embed("What is the capital of France?");
    await shortTtlStore.store(scope, "What is the capital of France?", embedding, dummyResponse("Paris"));

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const hit = await shortTtlStore.findSimilar(scope, embedding);
    expect(hit).toBeNull();
  }, 10000);

  // Hand-built NEAR-MISS prompts: lexically/semantically close to a cached prompt but with a different answer.
  // A semantic cache that serves any of these has a false positive (it would return a wrong answer).
  const NEAR_MISSES: { cached: string; probe: string }[] = [
    { cached: "What is the capital of France?", probe: "What is the capital of Germany?" },
    { cached: "How many days are in a week?", probe: "How many days are in a leap year?" },
    { cached: "What is 2 plus 2?", probe: "What is 2 plus 3?" },
    { cached: "Name one primary color.", probe: "Name one secondary color." },
    { cached: "Who wrote Romeo and Juliet?", probe: "Who wrote Hamlet?" },
    { cached: "What is the boiling point of water in Celsius?", probe: "What is the freezing point of water in Celsius?" },
    { cached: "Translate 'good morning' to Spanish.", probe: "Translate 'good morning' to French." },
    { cached: "How do I enable dark mode?", probe: "How do I disable dark mode?" },
    { cached: "What is the largest planet in the solar system?", probe: "What is the smallest planet in the solar system?" },
    { cached: "Convert 10 kilometers to miles.", probe: "Convert 10 miles to kilometers." },
  ];

  // Measured with gemini-embedding-001 (768d): near-miss similarities range 0.696-0.880 and true paraphrases
  // 0.807-0.900, so the ranges overlap. At 0.8, 5/10 near-misses hit (false positives); at 0.9 none do, at the cost of
  // paraphrase recall. The test pins the recommended default rather than the looser 0.8 used by the mechanism tests above.
  const RECOMMENDED_THRESHOLD = 0.9;

  it("false-positive set: near-miss prompts with different answers must NOT hit at the recommended threshold (real embeddings)", async () => {
    const strictStore = new SemanticCacheStore(pool, 60, RECOMMENDED_THRESHOLD);
    const falsePositives: { cached: string; probe: string; similarity: number }[] = [];
    for (const { cached, probe } of NEAR_MISSES) {
      const pairScope = { ...scope, model: `${testModel}-${randomUUID()}` }; // isolate each pair
      await store.store(pairScope, cached, await embed(cached), dummyResponse(`answer to: ${cached}`));
      const hit = await strictStore.findSimilar(pairScope, await embed(probe));
      if (hit) falsePositives.push({ cached, probe, similarity: hit.similarity });
    }
    expect(falsePositives, `false positives at threshold ${RECOMMENDED_THRESHOLD}`).toEqual([]);
  }, 120000);
});
