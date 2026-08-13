import type { Redis } from "ioredis";
import { env } from "../config/env.js";
import { ProviderAdapter } from "./types.js";
import { createGroqAdapter } from "./groq.js";
import { GeminiAdapter } from "./gemini.js";
import { createOpenRouterAdapter } from "./openrouter.js";
import { FaultInjectingAdapter } from "./faultInjector.js";

export function buildProviderRegistry(redis: Redis): Map<string, ProviderAdapter> {
  const registry = new Map<string, ProviderAdapter>();

  if (env.GROQ_API_KEY) {
    registry.set("groq", new FaultInjectingAdapter(createGroqAdapter(env.GROQ_API_KEY), redis));
  }
  if (env.GEMINI_API_KEY) {
    registry.set("gemini", new FaultInjectingAdapter(new GeminiAdapter(env.GEMINI_API_KEY), redis));
  }
  if (env.OPENROUTER_API_KEY) {
    registry.set("openrouter", new FaultInjectingAdapter(createOpenRouterAdapter(env.OPENROUTER_API_KEY), redis));
  }

  if (registry.size === 0) {
    throw new Error("No provider API keys configured. Set at least one of GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY.");
  }

  return registry;
}
