import { OpenAICompatibleAdapter } from "./openAICompatible.js";

export function createGroqAdapter(apiKey: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey,
    defaultModel: "llama-3.1-8b-instant",
  });
}
