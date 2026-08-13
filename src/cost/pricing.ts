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

export function estimateRequestCostUsd(provider: string, model: string, estimatedTotalTokens: number): number {
  const pricing = getPricing(provider, model);
  return (estimatedTotalTokens / 1_000_000) * pricing.outputPerMillion;
}
