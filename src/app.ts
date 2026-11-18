import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { NextFunction, Request, Response } from "express";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import yaml from "js-yaml";
import type { Redis } from "ioredis";
import type pg from "pg";

import { buildProviderRegistry } from "./providers/registry.js";
import { CacheStore } from "./cache/cacheStore.js";
import { LatencyTracker } from "./observability/latencyTracker.js";
import { HealthTracker } from "./routing/health.js";
import { StaticPriorityStrategy } from "./routing/strategies/staticPriority.js";
import { LatencyBasedStrategy } from "./routing/strategies/latencyBased.js";
import { Router as GatewayRouter, SemanticCacheDeps } from "./routing/router.js";
import { SemanticCacheStore } from "./cache/semanticCache.js";
import { embedText } from "./providers/embeddings.js";
import { RateLimiter } from "./rateLimit/limiter.js";
import { BudgetEnforcer } from "./cost/budget.js";
import { CostTracker } from "./cost/costTracker.js";
import { requestIdMiddleware } from "./api/middleware/requestId.js";
import { createApiKeyAuthMiddleware } from "./api/middleware/auth.js";
import { adminAuth } from "./api/middleware/adminAuth.js";
import { createChatRouter } from "./api/routes/chat.js";
import { createKeysRouter } from "./api/routes/keys.js";
import { createUsageRouter } from "./api/routes/usage.js";
import { createMetricsRouter } from "./api/routes/metricsRoutes.js";
import { createAdminRouter } from "./api/routes/admin.js";
import { createHealthRouter } from "./api/routes/health.js";
import { logger } from "./observability/logger.js";
import { env, providerPriority } from "./config/env.js";
import "./api/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(redis: Redis, pool: pg.Pool) {
  const registry = buildProviderRegistry(redis);
  const cacheStore = new CacheStore(redis);
  const latencyTracker = new LatencyTracker(redis);
  const healthTracker = new HealthTracker(redis);
  const strategies = {
    static_priority: new StaticPriorityStrategy(providerPriority),
    latency_based: new LatencyBasedStrategy(latencyTracker),
  };
  const semanticCache: SemanticCacheDeps | undefined =
    env.SEMANTIC_CACHE_ENABLED && env.GEMINI_API_KEY
      ? {
          store: new SemanticCacheStore(pool, env.CACHE_TTL_SECONDS, env.SEMANTIC_CACHE_SIMILARITY_THRESHOLD),
          embed: (text: string) => embedText(env.GEMINI_API_KEY, env.EMBEDDING_MODEL, text),
        }
      : undefined;
  // Expired rows are already ignored by reads; the sweep keeps the table and HNSW index from growing forever.
  semanticCache?.store.startSweeper(env.SEMANTIC_CACHE_SWEEP_INTERVAL_MS, (err) => logger.warn({ err }, "semantic cache sweep failed"));

  const gatewayRouter = new GatewayRouter(registry, cacheStore, latencyTracker, healthTracker, strategies, semanticCache);
  const rateLimiter = new RateLimiter(redis);
  const budgetEnforcer = new BudgetEnforcer(redis);
  const costTracker = new CostTracker(pool);
  const apiKeyAuth = createApiKeyAuthMiddleware(pool);

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(requestIdMiddleware);
  app.use(pinoHttp({ logger }));

  app.use(createHealthRouter());

  const openapiPath = path.join(__dirname, "..", "openapi.yaml");
  const openapiDoc = yaml.load(readFileSync(openapiPath, "utf8")) as object;
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiDoc));

  app.use("/v1/chat/completions", apiKeyAuth);
  app.use("/v1/usage", apiKeyAuth);
  app.use("/v1/keys", adminAuth);
  app.use("/admin", adminAuth);

  app.use(createChatRouter({ pool, router: gatewayRouter, rateLimiter, budgetEnforcer, costTracker, registry }));
  app.use(createUsageRouter({ costTracker, budgetEnforcer }));
  app.use(createKeysRouter(pool));
  app.use(createAdminRouter(redis));
  app.use(createMetricsRouter(redis, [...registry.keys()]));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "unhandled error");
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}
