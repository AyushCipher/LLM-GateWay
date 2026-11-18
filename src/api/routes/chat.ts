import { Router as ExpressRouter, Request, Response } from "express";
import { z } from "zod";
import type pg from "pg";
import { Router, AllProvidersFailedError, RouteAttempt, RouteResult } from "../../routing/router.js";
import { RateLimiter } from "../../rateLimit/limiter.js";
import { BudgetEnforcer } from "../../cost/budget.js";
import { CostTracker, RequestStatus } from "../../cost/costTracker.js";
import { computeCostUsd, estimateWorstCaseCostUsd, UnknownModelPricingError } from "../../cost/pricing.js";
import { estimateTokens } from "../../cost/tokenEstimate.js";
import { logger } from "../../observability/logger.js";
import { asyncHandler } from "../asyncHandler.js";
import type { PartialStream } from "../../routing/router.js";
import { getTraceId } from "../../observability/tracing.js";
import { requestsTotal, gatewayLatencyHistogram } from "../../observability/metrics.js";
import { env } from "../../config/env.js";
import { ProviderAdapter, TokenUsage, UnifiedChatRequest } from "../../providers/types.js";
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
  | { ok: true; reservation: Reservation }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Everything reserved up front and therefore everything that must be reconciled exactly once. */
interface Reservation {
  estimatedTokens: number;
  estimatedCostUsd: number;
  budgetPeriod: string;
}

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

function resolveModelFor(adapter: ProviderAdapter, model: string): string {
  return model === "default" || !model ? adapter.defaultModel : model;
}

async function runPreflight(
  deps: ChatDeps,
  traceId: string,
  apiKey: ApiKeyRecord,
  strategyName: string,
  promptText: string,
  request: UnifiedChatRequest,
): Promise<PreflightResult> {
  const promptTokens = estimateTokens(promptText);
  const maxCompletionTokens = request.maxTokens ?? 512;
  const estimatedTokens = promptTokens + maxCompletionTokens;

  // Price first: it is pure, and a request we cannot price must be rejected before it consumes any quota.
  // Fail closed: reserve the worst case across every provider the request could fall back to.
  let estimatedCostUsd: number;
  try {
    const candidates = [...deps.registry.values()].map((a) => ({ provider: a.name, model: resolveModelFor(a, request.model) }));
    estimatedCostUsd = estimateWorstCaseCostUsd(candidates, promptTokens, maxCompletionTokens);
  } catch (err) {
    if (err instanceof UnknownModelPricingError) {
      return { ok: false, status: 422, body: { error: "model has no configured price", provider: err.provider, model: err.model } };
    }
    throw err;
  }

  // Ordering: every stage that rejects must hand back what earlier stages took, so rejected requests burn no quota.
  const requestsAllowed = await deps.rateLimiter.checkRequestLimit(apiKey.id, apiKey.requests_per_minute); // undoes its own INCR on reject
  if (!requestsAllowed) {
    await recordRejection(deps, traceId, apiKey, strategyName, "rate_limited", "requests/min limit exceeded");
    return { ok: false, status: 429, body: { error: "rate limit exceeded", limitType: "requests_per_minute" } };
  }

  const tokensAllowed = await deps.rateLimiter.reserveTokens(apiKey.id, estimatedTokens, apiKey.tokens_per_minute);
  if (!tokensAllowed) {
    await deps.rateLimiter.refundRequest(apiKey.id);
    await recordRejection(deps, traceId, apiKey, strategyName, "rate_limited", "tokens/min limit exceeded");
    return { ok: false, status: 429, body: { error: "rate limit exceeded", limitType: "tokens_per_minute" } };
  }

  const budgetResult = await deps.budgetEnforcer.reserve(apiKey.id, estimatedCostUsd, Number(apiKey.budget_usd_monthly), apiKey.budget_mode);
  if (!budgetResult.allowed) {
    await deps.rateLimiter.adjustTokens(apiKey.id, estimatedTokens, 0);
    await deps.rateLimiter.refundRequest(apiKey.id);
    await recordRejection(deps, traceId, apiKey, strategyName, "budget_rejected", "monthly budget cap exceeded");
    return {
      ok: false,
      status: 402,
      body: { error: "budget exceeded", currentSpendUsd: budgetResult.currentSpendUsd, capUsd: budgetResult.capUsd },
    };
  }

  return { ok: true, reservation: { estimatedTokens, estimatedCostUsd, budgetPeriod: budgetResult.period } };
}

/** Cost of what actually happened. If the model is somehow unpriced, charge the reservation (fail closed). */
function actualCost(reservation: Reservation, provider: string, model: string, usage: TokenUsage): number {
  try {
    return computeCostUsd(provider, model, usage);
  } catch (err) {
    logger.error({ err, provider, model }, "unpriced model at settlement; charging the reserved estimate");
    return reservation.estimatedCostUsd;
  }
}

/** Reconcile Redis reservations to actuals. Never throws: a failure here is logged, not allowed to skip the rest. */
async function reconcile(deps: ChatDeps, apiKey: ApiKeyRecord, reservation: Reservation, actualTokens: number, actualCostUsd: number): Promise<void> {
  const results = await Promise.allSettled([
    deps.rateLimiter.adjustTokens(apiKey.id, reservation.estimatedTokens, actualTokens),
    deps.budgetEnforcer.adjust(apiKey.id, reservation.estimatedCostUsd, actualCostUsd, reservation.budgetPeriod),
  ]);
  for (const r of results) {
    if (r.status === "rejected") logger.error({ err: r.reason, apiKeyId: apiKey.id }, "failed to reconcile reservation");
  }
}

async function safeRecord(deps: ChatDeps, params: Parameters<CostTracker["recordRequest"]>[0]): Promise<void> {
  try {
    await deps.costTracker.recordRequest(params);
  } catch (err) {
    logger.error({ err, traceId: params.traceId }, "failed to record request");
  }
}

async function finalizeSuccess(
  deps: ChatDeps,
  traceId: string,
  apiKey: ApiKeyRecord,
  reservation: Reservation,
  result: Pick<RouteResult, "response" | "cacheHit" | "strategyUsed" | "attempts" | "totalLatencyMs"> & { usageEstimated?: boolean },
): Promise<number> {
  const actualCostUsd = result.cacheHit ? 0 : actualCost(reservation, result.response.provider, result.response.model, result.response.usage);
  await reconcile(deps, apiKey, reservation, result.cacheHit ? 0 : result.response.usage.totalTokens, actualCostUsd);

  await safeRecord(deps, {
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
    usageEstimated: result.usageEstimated ?? false,
  });

  requestsTotal.inc({ status: "success" });
  gatewayLatencyHistogram.observe({ cache_hit: String(result.cacheHit) }, result.totalLatencyMs);

  return actualCostUsd;
}

/** A stream that produced output and then died / was abandoned: charge what was (or is estimated to have been) consumed, refund the rest. */
async function finalizePartial(
  deps: ChatDeps,
  traceId: string,
  apiKey: ApiKeyRecord,
  reservation: Reservation,
  strategyName: string,
  partial: PartialStream,
  attempts: RouteAttempt[],
  status: "error" | "aborted",
  errorMessage: string,
  latencyMs: number,
): Promise<number> {
  const { response, usageEstimated } = partial;
  const costUsd = actualCost(reservation, response.provider, response.model, response.usage);
  await reconcile(deps, apiKey, reservation, response.usage.totalTokens, costUsd);

  requestsTotal.inc({ status });
  await safeRecord(deps, {
    traceId,
    apiKeyId: apiKey.id,
    provider: response.provider,
    model: response.model,
    routingStrategy: strategyName,
    attemptedProviders: attempts.map((a) => a.provider),
    usage: response.usage,
    costUsd,
    cacheHit: false,
    latencyMs,
    status,
    error: errorMessage,
    partialOutput: true,
    usageEstimated,
  });
  return costUsd;
}

async function finalizeFailure(
  deps: ChatDeps,
  traceId: string,
  apiKey: ApiKeyRecord,
  strategyName: string,
  reservation: Reservation,
  attempts: RouteAttempt[],
  errorMessage: string,
  status: "error" | "aborted" = "error",
): Promise<void> {
  await reconcile(deps, apiKey, reservation, 0, 0);

  requestsTotal.inc({ status });
  await safeRecord(deps, {
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
    status,
    error: errorMessage,
  });
}

export function createChatRouter(deps: ChatDeps): ExpressRouter {
  const expressRouter = ExpressRouter();

  expressRouter.post("/v1/chat/completions", asyncHandler(async (req: Request, res: Response) => {
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
    const unifiedRequest: UnifiedChatRequest = {
      model: body.model,
      messages: body.messages,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      tenantId: apiKey.id,
    };

    const preflight = await runPreflight(deps, traceId, apiKey, strategyName, promptText, unifiedRequest);
    if (!preflight.ok) {
      res.status(preflight.status).json(preflight.body);
      return;
    }
    const { reservation } = preflight;

    // From here on a reservation is held. `settled` flips once it has been reconciled; the finally blocks
    // below guarantee that happens on every path (success, error, throw, client disconnect).
    let settled = false;

    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      // 'close' on the *response* fires when the underlying connection goes away; on the request it fires as
      // soon as the body has been read in modern Node, which would abort every stream immediately.
      const upstreamAbort = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) upstreamAbort.abort();
      });

      try {
        for await (const event of deps.router.routeStream(unifiedRequest, strategyName, upstreamAbort.signal)) {
          if (event.type === "chunk") {
            if (!upstreamAbort.signal.aborted) res.write(`data: ${JSON.stringify({ delta: event.delta })}\n\n`);
          } else if (event.type === "done") {
            settled = true;
            const costUsd = await finalizeSuccess(deps, traceId, apiKey, reservation, event);
            res.write(
              `data: ${JSON.stringify({
                done: true,
                provider: event.response.provider,
                model: event.response.model,
                usage: event.response.usage,
                usageEstimated: event.usageEstimated,
                cacheHit: event.cacheHit,
                cacheType: event.cacheType,
                costUsd,
                latencyMs: event.totalLatencyMs,
                routing: { strategy: event.strategyUsed, attempts: event.attempts },
              })}\n\n`,
            );
          } else if (event.type === "aborted") {
            settled = true;
            await finalizePartial(deps, traceId, apiKey, reservation, strategyName, event.partial, event.attempts, "aborted", "client disconnected", event.totalLatencyMs);
          } else {
            settled = true;
            if (event.partial) {
              await finalizePartial(deps, traceId, apiKey, reservation, strategyName, event.partial, event.attempts, "error", event.message, 0);
            } else {
              await finalizeFailure(deps, traceId, apiKey, strategyName, reservation, event.attempts, event.message);
            }
            res.write(`data: ${JSON.stringify({ error: event.message, attempts: event.attempts })}\n\n`);
          }
        }
      } catch (err) {
        logger.error({ err, traceId }, "streaming request failed");
        if (!res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify({ error: "internal error while streaming" })}\n\n`);
        }
      } finally {
        if (!settled) {
          // The stream ended without a terminal event (thrown error, consumer stopped early): give the whole reservation back.
          settled = true;
          await finalizeFailure(deps, traceId, apiKey, strategyName, reservation, [], "stream terminated without a result", upstreamAbort.signal.aborted ? "aborted" : "error");
        }
        upstreamAbort.abort();
        if (!res.writableEnded) res.end();
      }
      return;
    }

    try {
      const result = await deps.router.route(unifiedRequest, strategyName);
      settled = true;
      const costUsd = await finalizeSuccess(deps, traceId, apiKey, reservation, result);

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
      if (!settled) {
        settled = true;
        const attempts = err instanceof AllProvidersFailedError ? err.attempts : [];
        await finalizeFailure(deps, traceId, apiKey, strategyName, reservation, attempts, err instanceof Error ? err.message : String(err));
        if (err instanceof AllProvidersFailedError) {
          res.status(502).json({ error: "all providers failed", attempts: err.attempts });
          return;
        }
      }
      throw err;
    }
  }));

  return expressRouter;
}
