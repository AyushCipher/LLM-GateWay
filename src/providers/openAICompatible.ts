import { ProviderAdapter, ProviderError, UnifiedChatRequest, UnifiedChatResponse } from "./types.js";

interface OpenAICompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  extraHeaders?: Record<string, string>;
}

interface OpenAIChatCompletionResponse {
  choices: { message: { content: string | null } }[];
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Shared adapter for any provider that speaks the OpenAI chat-completions
 * wire format (Groq and OpenRouter both do).
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name: string;
  readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel;
    this.extraHeaders = config.extraHeaders ?? {};
  }

  async chat(request: UnifiedChatRequest, signal: AbortSignal): Promise<UnifiedChatResponse> {
    const model = request.model === "default" || !request.model ? this.defaultModel : request.model;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model,
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens ?? 512,
        }),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderError(this.name, "timeout", `${this.name} request timed out`, err);
      }
      throw new ProviderError(this.name, "network", `${this.name} network error: ${(err as Error).message}`, err);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 429) {
        throw new ProviderError(this.name, "rate_limit", `${this.name} rate limited: ${body}`);
      }
      if (res.status >= 500) {
        throw new ProviderError(this.name, "server_error", `${this.name} server error ${res.status}: ${body}`);
      }
      throw new ProviderError(this.name, "client_error", `${this.name} client error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as OpenAIChatCompletionResponse;
    const content = data.choices[0]?.message?.content ?? "";
    const usage = data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return {
      provider: this.name,
      model: data.model ?? model,
      content,
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      },
      raw: data,
    };
  }
}
