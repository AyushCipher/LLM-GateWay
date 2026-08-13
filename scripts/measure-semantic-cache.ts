import { writeFileSync } from "node:fs";
import { redis } from "../src/redis/client.js";
import { pool } from "../src/db/pool.js";
import { buildProviderRegistry } from "../src/providers/registry.js";
import { CacheStore } from "../src/cache/cacheStore.js";
import { SemanticCacheStore } from "../src/cache/semanticCache.js";
import { LatencyTracker } from "../src/observability/latencyTracker.js";
import { HealthTracker } from "../src/routing/health.js";
import { StaticPriorityStrategy } from "../src/routing/strategies/staticPriority.js";
import { Router } from "../src/routing/router.js";
import { embedText } from "../src/providers/embeddings.js";
import { env, providerPriority } from "../src/config/env.js";

interface Topic {
  id: string;
  phrasings: string[];
}

const TOPICS: Topic[] = [
  {
    id: "capital-of-france",
    phrasings: ["What is the capital of France?", "Tell me France's capital city.", "Which city is the capital of France?"],
  },
  {
    id: "days-in-a-week",
    phrasings: ["How many days are in a week?", "How many days does a week have?"],
  },
  {
    id: "two-plus-two",
    phrasings: ["What is 2 plus 2?", "What's the sum of 2 and 2?", "Calculate 2+2."],
  },
  {
    id: "primary-color",
    phrasings: ["Name one primary color.", "Give me the name of a primary color.", "Tell me a primary color."],
  },
];

const NOVEL_PROMPTS = [
  "What is the boiling point of water in Celsius?",
  "Who wrote Romeo and Juliet?",
  "What is the largest planet in the solar system?",
  "How many continents are there?",
  "What is the chemical symbol for gold?",
  "Name a programming language.",
];

interface WorkloadItem {
  prompt: string;
  topicId: string | null;
}

function buildWorkload(): WorkloadItem[] {
  const items: WorkloadItem[] = [];
  for (const topic of TOPICS) {
    for (const phrasing of topic.phrasings) items.push({ prompt: phrasing, topicId: topic.id });
  }
  for (const prompt of NOVEL_PROMPTS) items.push({ prompt, topicId: null });

  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

async function run() {
  if (!env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is required for semantic caching (embeddings) — skipping benchmark.");
    process.exit(1);
  }

  await redis.flushdb();
  await pool.query("DELETE FROM semantic_cache");

  const registry = buildProviderRegistry(redis);
  const cacheStore = new CacheStore(redis, 300);
  const semanticCache = {
    store: new SemanticCacheStore(pool, 300, env.SEMANTIC_CACHE_SIMILARITY_THRESHOLD),
    embed: (text: string) => embedText(env.GEMINI_API_KEY, env.EMBEDDING_MODEL, text),
  };
  const latencyTracker = new LatencyTracker(redis);
  const healthTracker = new HealthTracker(redis, 5);
  const strategy = new StaticPriorityStrategy(providerPriority);
  const router = new Router(registry, cacheStore, latencyTracker, healthTracker, { static_priority: strategy }, semanticCache);

  const workload = buildWorkload();
  const seenTopics = new Set<string>();
  const perRequest: { prompt: string; topicId: string | null; expectedRepeat: boolean; cacheHit: boolean; cacheType: string | null }[] = [];

  let exactHits = 0;
  let semanticHits = 0;
  let misses = 0;
  let correctlyPredicted = 0;

  for (const item of workload) {
    const expectedRepeat = item.topicId !== null && seenTopics.has(item.topicId);
    if (item.topicId) seenTopics.add(item.topicId);

    const result = await router.route({ model: "default", messages: [{ role: "user", content: item.prompt }], maxTokens: 15 }, "static_priority");

    if (result.cacheType === "exact") exactHits++;
    else if (result.cacheType === "semantic") semanticHits++;
    else misses++;

    const predictedCorrectly = expectedRepeat ? result.cacheType === "semantic" : result.cacheType === null;
    if (predictedCorrectly) correctlyPredicted++;

    perRequest.push({ prompt: item.prompt, topicId: item.topicId, expectedRepeat, cacheHit: result.cacheHit, cacheType: result.cacheType });
  }

  const totalExpectedRepeats = perRequest.filter((r) => r.expectedRepeat).length;
  const semanticHitsAmongExpectedRepeats = perRequest.filter((r) => r.expectedRepeat && r.cacheType === "semantic").length;

  const report = {
    measuredAt: new Date().toISOString(),
    workloadSize: workload.length,
    distinctPromptStrings: new Set(workload.map((w) => w.prompt)).size,
    exactHits,
    semanticHits,
    misses,
    overallHitRate: (exactHits + semanticHits) / workload.length,
    totalExpectedRepeats,
    semanticHitsAmongExpectedRepeats,
    semanticRecallOnRepeats: totalExpectedRepeats === 0 ? null : semanticHitsAmongExpectedRepeats / totalExpectedRepeats,
    predictionAccuracy: correctlyPredicted / workload.length,
    similarityThresholdUsed: env.SEMANTIC_CACHE_SIMILARITY_THRESHOLD,
    perRequest,
    note:
      "Every prompt string in this workload is unique (paraphrases, never literal duplicates), so exactHits is expected to be 0 — any hit at all can only come from the semantic-embedding layer, isolating what semantic caching specifically adds over exact-match alone.",
  };

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(new URL("./results/semantic-cache.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(
    `\nOverall hit-rate: ${(report.overallHitRate * 100).toFixed(1)}% (exact=${exactHits}, semantic=${semanticHits}, miss=${misses}). ` +
      `Semantic recall on genuine repeats: ${totalExpectedRepeats === 0 ? "n/a" : `${semanticHitsAmongExpectedRepeats}/${totalExpectedRepeats}`}.`,
  );

  await redis.quit();
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
