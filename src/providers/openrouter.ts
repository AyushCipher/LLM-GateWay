import { OpenAICompatibleAdapter } from "./openAICompatible.js";

export function createOpenRouterAdapter(apiKey: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    defaultModel: "google/gemma-4-26b-a4b-it:free",
    extraHeaders: {
      "HTTP-Referer": "https://github.com/llm-gateway",
      "X-Title": "LLM Gateway",
    },
  });
}
