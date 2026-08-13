import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createTestPool } from "./testDb.js";
import { SemanticCacheStore } from "../../src/cache/semanticCache.js";
import { embedText } from "../../src/providers/embeddings.js";
import { env } from "../../src/config/env.js";
import { UnifiedChatResponse } from "../../src/providers/types.js";

const liveEmbeddingsAvailable = Boolean(env.GEMINI_API_KEY);

let pool: pg.Pool;
let store: SemanticCacheStore;
let testModel: string;

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
    store = new SemanticCacheStore(pool, 60, 0.8);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM semantic_cache WHERE model LIKE 'test-model-%'");
    await pool.end();
  });

  it("returns null when nothing is cached for this model", async () => {
    const embedding = await embed("What is the capital of France?");
    const hit = await store.findSimilar(testModel, embedding);
    expect(hit).toBeNull();
  });

  it("finds a differently-worded paraphrase above the similarity threshold", async () => {
    const originalEmbedding = await embed("What is the capital of France?");
    await store.store(testModel, "What is the capital of France?", originalEmbedding, dummyResponse("Paris"));

    const paraphraseEmbedding = await embed("Tell me France's capital city.");
    const hit = await store.findSimilar(testModel, paraphraseEmbedding);

    expect(hit).not.toBeNull();
    expect(hit!.response.content).toBe("Paris");
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.8);
  }, 20000);

  it("does not match an unrelated prompt", async () => {
    const originalEmbedding = await embed("What is the capital of France?");
    await store.store(testModel, "What is the capital of France?", originalEmbedding, dummyResponse("Paris"));

    const unrelatedEmbedding = await embed("What's 12 times 12?");
    const hit = await store.findSimilar(testModel, unrelatedEmbedding);

    expect(hit).toBeNull();
  }, 20000);

  it("never matches across different models", async () => {
    const embedding = await embed("What is the capital of France?");
    await store.store(testModel, "What is the capital of France?", embedding, dummyResponse("Paris"));

    const hit = await store.findSimilar(`${testModel}-other`, embedding);
    expect(hit).toBeNull();
  });

  it("excludes entries past their TTL", async () => {
    const shortTtlStore = new SemanticCacheStore(pool, 1, 0.8);
    const embedding = await embed("What is the capital of France?");
    await shortTtlStore.store(testModel, "What is the capital of France?", embedding, dummyResponse("Paris"));

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const hit = await shortTtlStore.findSimilar(testModel, embedding);
    expect(hit).toBeNull();
  }, 10000);
});
