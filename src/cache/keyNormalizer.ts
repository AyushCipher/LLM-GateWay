import { createHash } from "node:crypto";
import { UnifiedChatRequest } from "../providers/types.js";

export const ANONYMOUS_TENANT = "anonymous";
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_MAX_TOKENS = 512;

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function normalizedTemperature(request: Pick<UnifiedChatRequest, "temperature">): number {
  return request.temperature ?? DEFAULT_TEMPERATURE;
}

export function normalizedMaxTokens(request: Pick<UnifiedChatRequest, "maxTokens">): number {
  return request.maxTokens ?? DEFAULT_MAX_TOKENS;
}

/**
 * `modelScope` replaces `request.model` in the key. The router passes a provider-qualified scope when the
 * caller asked for the literal model "default", because "default" resolves to a different concrete model on
 * every provider and must never be shared between them.
 */
export function normalizeRequest(request: UnifiedChatRequest, modelScope?: string): string {
  const normalized = {
    tenantId: request.tenantId ?? ANONYMOUS_TENANT,
    model: modelScope ?? request.model,
    messages: request.messages.map((m) => ({ role: m.role, content: collapseWhitespace(m.content) })),
    temperature: normalizedTemperature(request),
    maxTokens: normalizedMaxTokens(request),
  };
  return JSON.stringify(normalized);
}

export function cacheKeyFor(request: UnifiedChatRequest, modelScope?: string): string {
  const normalized = normalizeRequest(request, modelScope);
  const hash = createHash("sha256").update(normalized).digest("hex");
  return `cache:response:${request.tenantId ?? ANONYMOUS_TENANT}:${hash}`;
}
