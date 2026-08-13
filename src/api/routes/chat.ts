import { Router as ExpressRouter, Request, Response } from "express";
import { z } from "zod";
import type pg from "pg";
import { Router, AllProvidersFailedError, RouteAttempt, RouteResult } from "../../routing/router.js";
import { RateLimiter } from "../../rateLimit/limiter.js";
import { BudgetEnforcer } from "../../cost/budget.js";
import { CostTracker, RequestStatus } from "../../cost/costTracker.js";
import { computeCostUsd, estimateRequestCostUsd } from "../../cost/pricing.js";
import { getTraceId } from "../../observability/tracing.js";
import { requestsTotal, gatewayLatencyHistogram } from "../../observability/metrics.js";
import { env, providerPriority } from "../../config/env.js";
import { ProviderAdapter, TokenUsage } from "../../providers/types.js";
import { ApiKeyRecord } from "../types.js";

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
  stream: z.boolean().optional().default(false),
});

type ChatDeps = {
  pool: pg.Pool;
  router: Router;
  rateLimiter: RateLimiter;
  budgetEnforcer: BudgetEnforcer;
  costTracker: CostTracker;
  registry: Map<string, ProviderAdapter>;
};

type PreflightResult =
  | { ok: true; estimatedTokens: number; estimatedCostUsd: number }
  | { ok: false; status: number; body: Record<string, unknown> };

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

async function recordRejection(
  deps: ChatDeps,
  traceId: string,
  apiKey: ApiKeyRecord,
  strategyName: string,
  status: RequestStatus,
  error: string,
): Promise<void> {
  requestsTotal.inc({ status });
  await deps.costTracker.recordRequest({
    traceId,
    apiKeyId: apiKey.id,
    provider: null,
    model: null,
    routingStrategy: strategyName,
    attemptedProviders: [],
    usage: ZERO_USAGE,
    costUsd: 0,
    cacheHit: false,
    latencyMs: 0,
    status,
    error,
  });
}

async function runPreflight(
  deps: ChatDeps,
  traceId: string,
  apiKey: ApiKeyRecord,
  strategyName: string,
  promptText: string,
  maxTokens: number | undefined,
): Promise<PreflightResult> {
  const requestsAllowed = await deps.rateLimiter.checkRequestLimit(apiKey.id, apiKey.requests_per_minute);
  if (!requestsAllowed) {
    await recordRejection(deps, traceId, apiKey, strategyName, "rate_limited", "requests/min limit exceeded");
    return { ok: false, status: 429, body: { error: "rate limit exceeded", limitType: "requests_per_minute" } };
  }

  const estimatedTokens = RateLimiter.estimateTokens(promptText) + (maxTokens ?? 512);
  const tokensAllowed = await deps.rateLimiter.reserveTokens(apiKey.id, estimatedTokens, apiKey.tokens_per_minute);
  if (!tokensAllowed) {
    await recordRejection(deps, traceId, apiKey, strategyName, "rate_limited", "tokens/min limit exceeded");
    return { ok: false, status: 429, body: { error: "rate limit exceeded", limitType: "tokens_per_minute" } };
  }

  const primaryProviderName = providerPriority.find((p) => deps.registry.has(p)) ?? [...deps.registry.keys()][0]!;
  const primaryAdapter = deps.registry.get(primaryProviderName)!;
  const estimatedCostUsd = estimateRequestCostUsd(primaryProviderName, primaryAdapter.defaultModel, estimatedTokens);

  const budgetResult = await deps.budgetEnforcer.reserve(apiKey.id, estimatedCostUsd, Number(apiKey.budget_usd_monthly), apiKey.budget_mode);
  if (!budgetResult.allowed) {
    await deps.rateLimiter.adjustTokens(apiKey.id, estimatedTokens, 0);
    await recordRejection(deps, traceId, apiKey, strategyName, "budget_rejected", "monthly budget cap exceeded");
    return {
      ok: false,
      status: 402,
      body: { error: "budget exceeded", currentSpendUsd: budgetResult.currentSpendUsd, capUsd: budgetResult.capUsd },
    };
  }

  return { ok: true, estimatedTokens, estimatedCostUsd };
}

async function finalizeSuccess(
  deps: ChatDeps,
  traceId: string,
  apiKey: ApiKeyRecord,
  estimatedTokens: number,
  estimatedCostUsd: number,
  result: Pick<RouteResult, "response" | "cacheHit" | "strategyUsed" | "attempts" | "totalLatencyMs">,
): Promise<number> {
  const actualTokens = result.response.usage.totalTokens;
  await deps.rateLimiter.adjustTokens(apiKey.id, estimatedTokens, actualTokens);

  const actualCostUsd = result.cacheHit ? 0 : computeCostUsd(result.response.provider, result.response.model, result.response.usage);
  await deps.budgetEnforcer.adjust(apiKey.id, estimatedCostUsd, actualCostUsd);

  await deps.costTracker.recordRequest({
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

  return actualCostUsd;
}

async function finalizeFailure(
  deps: ChatDeps,
  traceId: string,
  apiKey: ApiKeyRecord,
  strategyName: string,
  estimatedTokens: number,
  estimatedCostUsd: number,
  attempts: RouteAttempt[],
  errorMessage: string,
): Promise<void> {
  await deps.rateLimiter.adjustTokens(apiKey.id, estimatedTokens, 0);
  await deps.budgetEnforcer.adjust(apiKey.id, estimatedCostUsd, 0);

  requestsTotal.inc({ status: "error" });
  await deps.costTracker.recordRequest({
    traceId,
    apiKeyId: apiKey.id,
    provider: null,
    model: null,
    routingStrategy: strategyName,
    attemptedProviders: attempts.map((a) => a.provider),
    usage: ZERO_USAGE,
    costUsd: 0,
    cacheHit: false,
    latencyMs: 0,
    status: "error",
    error: errorMessage,
  });
}

export function createChatRouter(deps: ChatDeps): ExpressRouter {
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
    const promptText = body.messages.map((m) => m.content).join(" ");
    const unifiedRequest = { model: body.model, messages: body.messages, temperature: body.temperature, maxTokens: body.maxTokens };

    const preflight = await runPreflight(deps, traceId, apiKey, strategyName, promptText, body.maxTokens);
    if (!preflight.ok) {
      res.status(preflight.status).json(preflight.body);
      return;
    }
    const { estimatedTokens, estimatedCostUsd } = preflight;

    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      let clientDisconnected = false;
      req.on("close", () => {
        clientDisconnected = true;
      });

      for await (const event of deps.router.routeStream(unifiedRequest, strategyName)) {
        if (clientDisconnected) break;

        if (event.type === "chunk") {
          res.write(`data: ${JSON.stringify({ delta: event.delta })}\n\n`);
        } else if (event.type === "done") {
          const costUsd = await finalizeSuccess(deps, traceId, apiKey, estimatedTokens, estimatedCostUsd, event);
          res.write(
            `data: ${JSON.stringify({
              done: true,
              provider: event.response.provider,
              model: event.response.model,
              usage: event.response.usage,
              cacheHit: event.cacheHit,
              cacheType: event.cacheType,
              costUsd,
              latencyMs: event.totalLatencyMs,
              routing: { strategy: event.strategyUsed, attempts: event.attempts },
            })}\n\n`,
          );
        } else {
          await finalizeFailure(deps, traceId, apiKey, strategyName, estimatedTokens, estimatedCostUsd, event.attempts, event.message);
          res.write(`data: ${JSON.stringify({ error: event.message, attempts: event.attempts })}\n\n`);
        }
      }

      res.end();
      return;
    }

    try {
      const result = await deps.router.route(unifiedRequest, strategyName);
      const costUsd = await finalizeSuccess(deps, traceId, apiKey, estimatedTokens, estimatedCostUsd, result);

      res.json({
        id: traceId,
        provider: result.response.provider,
        model: result.response.model,
        content: result.response.content,
        usage: result.response.usage,
        cacheHit: result.cacheHit,
        cacheType: result.cacheType,
        costUsd,
        latencyMs: result.totalLatencyMs,
        routing: { strategy: result.strategyUsed, attempts: result.attempts },
      });
    } catch (err) {
      if (err instanceof AllProvidersFailedError) {
        await finalizeFailure(deps, traceId, apiKey, strategyName, estimatedTokens, estimatedCostUsd, err.attempts, err.message);
        res.status(502).json({ error: "all providers failed", attempts: err.attempts });
        return;
      }
      throw err;
    }
  });

  return expressRouter;
}
