import { TokenUsage } from "../providers/types.js";

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

/** Thrown instead of silently pricing an unknown model at $0 (which would make spend caps meaningless). */
export class UnknownModelPricingError extends Error {
  constructor(
    public readonly provider: string,
    public readonly model: string,
  ) {
    super(`No pricing configured for ${provider}/${model}; add it to PRICING_TABLE or call registerPricing()`);
    this.name = "UnknownModelPricingError";
  }
}

/** Explicitly price a model (e.g. at startup) rather than relying on a default. */
export function registerPricing(provider: string, model: string, pricing: ModelPricing): void {
  (PRICING_TABLE[provider] ??= {})[model] = pricing;
}

export function getPricing(provider: string, model: string): ModelPricing {
  const pricing = PRICING_TABLE[provider]?.[model];
  if (!pricing) throw new UnknownModelPricingError(provider, model);
  return pricing;
}

export function computeCostUsd(provider: string, model: string, usage: TokenUsage): number {
  const pricing = getPricing(provider, model);
  const inputCost = (usage.promptTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (usage.completionTokens / 1_000_000) * pricing.outputPerMillion;
  return inputCost + outputCost;
}

export interface PricingCandidate {
  provider: string;
  model: string;
}

/**
 * Upper-bound reservation: the most expensive (input + output) price among every provider the request could
 * fall back to, assuming the full prompt is billed as input and the full maxTokens as output.
 * Throws UnknownModelPricingError if any candidate is unpriced (fail closed).
 */
export function estimateWorstCaseCostUsd(candidates: PricingCandidate[], promptTokens: number, maxCompletionTokens: number): number {
  if (candidates.length === 0) throw new Error("estimateWorstCaseCostUsd: no candidate providers");
  const usage: TokenUsage = { promptTokens, completionTokens: maxCompletionTokens, totalTokens: promptTokens + maxCompletionTokens };
  return Math.max(...candidates.map((c) => computeCostUsd(c.provider, c.model, usage)));
}
