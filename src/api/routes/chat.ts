import { Router as ExpressRouter, Request, Response } from "express";
import { z } from "zod";
import type pg from "pg";
import { Router, AllProvidersFailedError } from "../../routing/router.js";
import { RateLimiter } from "../../rateLimit/limiter.js";
import { BudgetEnforcer } from "../../cost/budget.js";
import { CostTracker } from "../../cost/costTracker.js";
import { computeCostUsd, estimateRequestCostUsd } from "../../cost/pricing.js";
import { getTraceId } from "../../observability/tracing.js";
import { requestsTotal, gatewayLatencyHistogram } from "../../observability/metrics.js";
import { env, providerPriority } from "../../config/env.js";
import { ProviderAdapter } from "../../providers/types.js";

const chatRequestSchema = z.object({
  model: z.string().optional().default("default"),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1),
      }),
    )
    .min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(4096).optional(),
  routingStrategy: z.enum(["static_priority", "latency_based"]).optional(),
});

export function createChatRouter(deps: {
  pool: pg.Pool;
  router: Router;
  rateLimiter: RateLimiter;
  budgetEnforcer: BudgetEnforcer;
  costTracker: CostTracker;
  registry: Map<string, ProviderAdapter>;
}): ExpressRouter {
  const { router, rateLimiter, budgetEnforcer, costTracker, registry } = deps;
  const expressRouter = ExpressRouter();

  expressRouter.post("/v1/chat/completions", async (req: Request, res: Response) => {
    const apiKey = req.apiKey!;
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request body", details: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;
    const traceId = getTraceId();
    const strategyName = body.routingStrategy ?? env.ROUTING_STRATEGY;

    const requestsAllowed = await rateLimiter.checkRequestLimit(apiKey.id, apiKey.requests_per_minute);
    if (!requestsAllowed) {
      requestsTotal.inc({ status: "rate_limited" });
      await costTracker.recordRequest({
        traceId,
        apiKeyId: apiKey.id,
        provider: null,
        model: null,
        routingStrategy: strategyName,
        attemptedProviders: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costUsd: 0,
        cacheHit: false,
        latencyMs: 0,
        status: "rate_limited",
        error: "requests/min limit exceeded",
      });
      res.status(429).json({ error: "rate limit exceeded", limitType: "requests_per_minute" });
      return;
    }

    const promptText = body.messages.map((m) => m.content).join(" ");
    const estimatedTokens = RateLimiter.estimateTokens(promptText) + (body.maxTokens ?? 512);

    const tokensAllowed = await rateLimiter.reserveTokens(apiKey.id, estimatedTokens, apiKey.tokens_per_minute);
    if (!tokensAllowed) {
      requestsTotal.inc({ status: "rate_limited" });
      await costTracker.recordRequest({
        traceId,
        apiKeyId: apiKey.id,
        provider: null,
        model: null,
        routingStrategy: strategyName,
        attemptedProviders: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costUsd: 0,
        cacheHit: false,
        latencyMs: 0,
        status: "rate_limited",
        error: "tokens/min limit exceeded",
      });
      res.status(429).json({ error: "rate limit exceeded", limitType: "tokens_per_minute" });
      return;
    }

    const primaryProviderName = providerPriority.find((p) => registry.has(p)) ?? [...registry.keys()][0]!;
    const primaryAdapter = registry.get(primaryProviderName)!;
    const estimatedCostUsd = estimateRequestCostUsd(primaryProviderName, primaryAdapter.defaultModel, estimatedTokens);

    const budgetResult = await budgetEnforcer.reserve(
      apiKey.id,
      estimatedCostUsd,
      Number(apiKey.budget_usd_monthly),
      apiKey.budget_mode,
    );
    if (!budgetResult.allowed) {
      await rateLimiter.adjustTokens(apiKey.id, estimatedTokens, 0);
      requestsTotal.inc({ status: "budget_rejected" });
      await costTracker.recordRequest({
        traceId,
        apiKeyId: apiKey.id,
        provider: null,
        model: null,
        routingStrategy: strategyName,
        attemptedProviders: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costUsd: 0,
        cacheHit: false,
        latencyMs: 0,
        status: "budget_rejected",
        error: "monthly budget cap exceeded",
      });
      res.status(402).json({
        error: "budget exceeded",
        currentSpendUsd: budgetResult.currentSpendUsd,
        capUsd: budgetResult.capUsd,
      });
      return;
    }

    try {
      const result = await router.route(
        { model: body.model, messages: body.messages, temperature: body.temperature, maxTokens: body.maxTokens },
        strategyName,
      );

      const actualTokens = result.response.usage.totalTokens;
      await rateLimiter.adjustTokens(apiKey.id, estimatedTokens, actualTokens);

      const actualCostUsd = result.cacheHit
        ? 0
        : computeCostUsd(result.response.provider, result.response.model, result.response.usage);
      await budgetEnforcer.adjust(apiKey.id, estimatedCostUsd, actualCostUsd);

      await costTracker.recordRequest({
        traceId,
        apiKeyId: apiKey.id,
        provider: result.response.provider,
        model: result.response.model,
        routingStrategy: result.strategyUsed,
        attemptedProviders: result.attempts.map((a) => a.provider),
        usage: result.response.usage,
        costUsd: actualCostUsd,
        cacheHit: result.cacheHit,
        latencyMs: result.totalLatencyMs,
        status: "success",
      });

      requestsTotal.inc({ status: "success" });
      gatewayLatencyHistogram.observe({ cache_hit: String(result.cacheHit) }, result.totalLatencyMs);

      res.json({
        id: traceId,
        provider: result.response.provider,
        model: result.response.model,
        content: result.response.content,
        usage: result.response.usage,
        cacheHit: result.cacheHit,
        costUsd: actualCostUsd,
        latencyMs: result.totalLatencyMs,
        routing: { strategy: result.strategyUsed, attempts: result.attempts },
      });
    } catch (err) {
      await rateLimiter.adjustTokens(apiKey.id, estimatedTokens, 0);
      await budgetEnforcer.adjust(apiKey.id, estimatedCostUsd, 0);

      if (err instanceof AllProvidersFailedError) {
        requestsTotal.inc({ status: "error" });
        await costTracker.recordRequest({
          traceId,
          apiKeyId: apiKey.id,
          provider: null,
          model: null,
          routingStrategy: strategyName,
          attemptedProviders: err.attempts.map((a) => a.provider),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          costUsd: 0,
          cacheHit: false,
          latencyMs: 0,
          status: "error",
          error: err.message,
        });
        res.status(502).json({ error: "all providers failed", attempts: err.attempts });
        return;
      }

      throw err;
    }
  });

  return expressRouter;
}
