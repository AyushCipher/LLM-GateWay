import { ProviderAdapter, ProviderError, UnifiedChatRequest, UnifiedChatResponse } from "./types.js";
import { StreamChunk } from "./streamTypes.js";
import { parseSSE } from "./sse.js";

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

interface OpenAIStreamChunk {
  choices: { delta: { content?: string } }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

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

  private resolveModel(request: UnifiedChatRequest): string {
    return request.model === "default" || !request.model ? this.defaultModel : request.model;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderError(this.name, "timeout", `${this.name} request timed out`, err);
      }
      throw new ProviderError(this.name, "network", `${this.name} network error: ${(err as Error).message}`, err);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 429) {
        throw new ProviderError(this.name, "rate_limit", `${this.name} rate limited: ${text}`);
      }
      if (res.status >= 500) {
        throw new ProviderError(this.name, "server_error", `${this.name} server error ${res.status}: ${text}`);
      }
      throw new ProviderError(this.name, "client_error", `${this.name} client error ${res.status}: ${text}`);
    }

    return res;
  }

  async chat(request: UnifiedChatRequest, signal: AbortSignal): Promise<UnifiedChatResponse> {
    const model = this.resolveModel(request);
    const res = await this.post(
      {
        model,
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 512,
      },
      signal,
    );

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

  async *chatStream(request: UnifiedChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const model = this.resolveModel(request);
    const res = await this.post(
      {
        model,
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 512,
        stream: true,
        stream_options: { include_usage: true },
      },
      signal,
    );

    if (!res.body) {
      throw new ProviderError(this.name, "network", `${this.name} streaming response had no body`);
    }

    for await (const payload of parseSSE(res.body)) {
      const chunk = JSON.parse(payload) as OpenAIStreamChunk;
      const delta = chunk.choices[0]?.delta?.content ?? "";
      const usage = chunk.usage
        ? {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          }
        : undefined;

      if (delta || usage) {
        yield { delta, usage };
      }
    }
  }
}
