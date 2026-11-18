import type { StreamChunk } from "./streamTypes.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface UnifiedChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** api_keys.id of the caller. Namespaces every cache lookup/write; never forwarded to providers. */
  tenantId?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UnifiedChatResponse {
  provider: string;
  model: string;
  content: string;
  usage: TokenUsage;
  raw: unknown;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly kind: "timeout" | "rate_limit" | "server_error" | "client_error" | "network",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderAdapter {
  readonly name: string;
  readonly defaultModel: string;
  chat(request: UnifiedChatRequest, signal: AbortSignal): Promise<UnifiedChatResponse>;
  chatStream(request: UnifiedChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk>;
}
