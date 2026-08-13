import type { Redis } from "ioredis";
import { ProviderAdapter, ProviderError, UnifiedChatRequest, UnifiedChatResponse } from "./types.js";
import { StreamChunk } from "./streamTypes.js";

export type FaultMode = "timeout" | "error_5xx" | "rate_limit";

const FAULT_KEY_PREFIX = "fault:";

export class FaultInjectingAdapter implements ProviderAdapter {
  readonly name: string;
  readonly defaultModel: string;

  constructor(
    private readonly inner: ProviderAdapter,
    private readonly redis: Redis,
  ) {
    this.name = inner.name;
    this.defaultModel = inner.defaultModel;
  }

  async chat(request: UnifiedChatRequest, signal: AbortSignal): Promise<UnifiedChatResponse> {
    const mode = (await this.redis.get(FAULT_KEY_PREFIX + this.name)) as FaultMode | null;

    if (mode === "timeout") {
      throw new ProviderError(this.name, "timeout", `[fault-injected] ${this.name} forced timeout`);
    }
    if (mode === "error_5xx") {
      throw new ProviderError(this.name, "server_error", `[fault-injected] ${this.name} forced 500`);
    }
    if (mode === "rate_limit") {
      throw new ProviderError(this.name, "rate_limit", `[fault-injected] ${this.name} forced 429`);
    }

    return this.inner.chat(request, signal);
  }

  async *chatStream(request: UnifiedChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const mode = (await this.redis.get(FAULT_KEY_PREFIX + this.name)) as FaultMode | null;

    if (mode === "timeout") {
      throw new ProviderError(this.name, "timeout", `[fault-injected] ${this.name} forced timeout`);
    }
    if (mode === "error_5xx") {
      throw new ProviderError(this.name, "server_error", `[fault-injected] ${this.name} forced 500`);
    }
    if (mode === "rate_limit") {
      throw new ProviderError(this.name, "rate_limit", `[fault-injected] ${this.name} forced 429`);
    }

    yield* this.inner.chatStream(request, signal);
  }
}

export async function setFault(redis: Redis, provider: string, mode: FaultMode | "clear"): Promise<void> {
  const key = FAULT_KEY_PREFIX + provider;
  if (mode === "clear") {
    await redis.del(key);
  } else {
    await redis.set(key, mode, "EX", 3600);
  }
}

export async function getFault(redis: Redis, provider: string): Promise<string | null> {
  return redis.get(FAULT_KEY_PREFIX + provider);
}
