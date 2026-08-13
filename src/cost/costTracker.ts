import type pg from "pg";
import { TokenUsage } from "../providers/types.js";

export type RequestStatus = "success" | "error" | "budget_rejected" | "rate_limited";

export interface RecordRequestParams {
  traceId: string;
  apiKeyId: string;
  provider: string | null;
  model: string | null;
  routingStrategy: string;
  attemptedProviders: string[];
  usage: TokenUsage;
  costUsd: number;
  cacheHit: boolean;
  latencyMs: number;
  status: RequestStatus;
  error?: string;
}

export interface UsageSummary {
  totalCostUsd: number;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  cacheHits: number;
  byProvider: { provider: string; requests: number; costUsd: number }[];
}

export class CostTracker {
  constructor(private readonly pool: pg.Pool) {}

  async recordRequest(p: RecordRequestParams): Promise<void> {
    await this.pool.query(
      `INSERT INTO requests
        (trace_id, api_key_id, provider, model, routing_strategy, attempted_providers,
         prompt_tokens, completion_tokens, total_tokens, cost_usd, cache_hit, latency_ms, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        p.traceId,
        p.apiKeyId,
        p.provider,
        p.model,
        p.routingStrategy,
        p.attemptedProviders,
        p.usage.promptTokens,
        p.usage.completionTokens,
        p.usage.totalTokens,
        p.costUsd,
        p.cacheHit,
        p.latencyMs,
        p.status,
        p.error ?? null,
      ],
    );
  }

  async getUsage(apiKeyId: string, sinceHours: number): Promise<UsageSummary> {
    const totals = await this.pool.query<{
      total_cost_usd: string;
      total_requests: string;
      total_prompt_tokens: string;
      total_completion_tokens: string;
      cache_hits: string;
    }>(
      `SELECT
         COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
         COUNT(*) AS total_requests,
         COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens,
         COALESCE(SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END), 0) AS cache_hits
       FROM requests
       WHERE api_key_id = $1 AND created_at >= now() - ($2 || ' hours')::interval`,
      [apiKeyId, sinceHours],
    );

    const byProvider = await this.pool.query<{ provider: string; requests: string; cost_usd: string }>(
      `SELECT provider, COUNT(*) AS requests, COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM requests
       WHERE api_key_id = $1 AND created_at >= now() - ($2 || ' hours')::interval AND provider IS NOT NULL
       GROUP BY provider
       ORDER BY cost_usd DESC`,
      [apiKeyId, sinceHours],
    );

    const row = totals.rows[0]!;
    return {
      totalCostUsd: Number(row.total_cost_usd),
      totalRequests: Number(row.total_requests),
      totalPromptTokens: Number(row.total_prompt_tokens),
      totalCompletionTokens: Number(row.total_completion_tokens),
      cacheHits: Number(row.cache_hits),
      byProvider: byProvider.rows.map((r) => ({
        provider: r.provider,
        requests: Number(r.requests),
        costUsd: Number(r.cost_usd),
      })),
    };
  }
}
