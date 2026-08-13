import { TokenUsage } from "../providers/types.js";

/**
 * Manually-maintained pricing snapshot, $ per 1,000,000 tokens.
 * NOT fetched live from providers — see README "Known Limitations".
 *
 * Sources checked 2026-08-13:
 *  - Groq (console.groq.com/docs/models): llama-3.1-8b-instant $0.05 / $0.08 per 1M in/out
 *  - Google (ai.google.dev/gemini-api/docs/pricing): Gemini 3.5 Flash-Lite $0.30 / $2.50 per 1M in/out
 *    (gemini-flash-lite-latest currently resolves to gemini-3.5-flash-lite)
 *  - OpenRouter: google/gemma-4-26b-a4b-it:free is a $0-cost free-tier model
 *    (confirmed via live API response `cost: 0` on every call in this session)
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICING_TABLE: Record<string, Record<string, ModelPricing>> = {
  groq: {
    "llama-3.1-8b-instant": { inputPerMillion: 0.05, outputPerMillion: 0.08 },
  },
  gemini: {
    "gemini-flash-lite-latest": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
    "gemini-3.5-flash-lite": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  },
  openrouter: {
    "google/gemma-4-26b-a4b-it:free": { inputPerMillion: 0, outputPerMillion: 0 },
  },
};

const FALLBACK_PRICING: ModelPricing = { inputPerMillion: 0, outputPerMillion: 0 };

export function getPricing(provider: string, model: string): ModelPricing {
  return PRICING_TABLE[provider]?.[model] ?? FALLBACK_PRICING;
}

export function computeCostUsd(provider: string, model: string, usage: TokenUsage): number {
  const pricing = getPricing(provider, model);
  const inputCost = (usage.promptTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (usage.completionTokens / 1_000_000) * pricing.outputPerMillion;
  return inputCost + outputCost;
}

/**
 * Pre-call budget reservation estimate: since the eventual provider isn't
 * known until routing runs, this prices the whole estimated token count at
 * the (usually pricier) output rate for the configured primary provider —
 * a deliberately conservative over-estimate. It's reconciled to the real
 * cost via BudgetEnforcer.adjust() once the actual provider/usage is known.
 */
export function estimateRequestCostUsd(provider: string, model: string, estimatedTotalTokens: number): number {
  const pricing = getPricing(provider, model);
  return (estimatedTotalTokens / 1_000_000) * pricing.outputPerMillion;
}
