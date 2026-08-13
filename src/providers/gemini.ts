import { ProviderAdapter, ProviderError, UnifiedChatRequest, UnifiedChatResponse } from "./types.js";
import { StreamChunk } from "./streamTypes.js";
import { parseSSE } from "./sse.js";

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
  }[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export class GeminiAdapter implements ProviderAdapter {
  readonly name = "gemini";
  readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";

  constructor(apiKey: string, defaultModel = "gemini-flash-lite-latest") {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  private resolveModel(request: UnifiedChatRequest): string {
    return request.model === "default" || !request.model ? this.defaultModel : request.model;
  }

  private buildBody(request: UnifiedChatRequest): Record<string, unknown> {
    const systemMessages = request.messages.filter((m) => m.role === "system");
    const conversation = request.messages.filter((m) => m.role !== "system");

    return {
      contents: conversation.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      ...(systemMessages.length > 0
        ? { systemInstruction: { parts: [{ text: systemMessages.map((m) => m.content).join("\n") }] } }
        : {}),
      generationConfig: {
        temperature: request.temperature ?? 0.7,
        maxOutputTokens: request.maxTokens ?? 512,
      },
    };
  }

  private async post(url: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderError(this.name, "timeout", "gemini request timed out", err);
      }
      throw new ProviderError(this.name, "network", `gemini network error: ${(err as Error).message}`, err);
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      if (res.status === 429) {
        throw new ProviderError(this.name, "rate_limit", `gemini rate limited: ${bodyText}`);
      }
      if (res.status >= 500) {
        throw new ProviderError(this.name, "server_error", `gemini server error ${res.status}: ${bodyText}`);
      }
      throw new ProviderError(this.name, "client_error", `gemini client error ${res.status}: ${bodyText}`);
    }

    return res;
  }

  async chat(request: UnifiedChatRequest, signal: AbortSignal): Promise<UnifiedChatResponse> {
    const model = this.resolveModel(request);
    const res = await this.post(`${this.baseUrl}/${model}:generateContent?key=${this.apiKey}`, this.buildBody(request), signal);

    const data = (await res.json()) as GeminiResponse;
    const content = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const usage = data.usageMetadata ?? { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };

    return {
      provider: this.name,
      model,
      content,
      usage: {
        promptTokens: usage.promptTokenCount,
        completionTokens: usage.candidatesTokenCount,
        totalTokens: usage.totalTokenCount,
      },
      raw: data,
    };
  }

  async *chatStream(request: UnifiedChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const model = this.resolveModel(request);
    const res = await this.post(
      `${this.baseUrl}/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
      this.buildBody(request),
      signal,
    );

    if (!res.body) {
      throw new ProviderError(this.name, "network", "gemini streaming response had no body");
    }

    for await (const payload of parseSSE(res.body)) {
      const data = JSON.parse(payload) as GeminiResponse;
      const delta = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const usage = data.usageMetadata
        ? {
            promptTokens: data.usageMetadata.promptTokenCount,
            completionTokens: data.usageMetadata.candidatesTokenCount,
            totalTokens: data.usageMetadata.totalTokenCount,
          }
        : undefined;

      if (delta || usage) {
        yield { delta, usage };
      }
    }
  }
}
