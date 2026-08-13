import { createHash } from "node:crypto";
import { UnifiedChatRequest } from "../providers/types.js";

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function normalizeRequest(request: UnifiedChatRequest): string {
  const normalized = {
    model: request.model,
    messages: request.messages.map((m) => ({ role: m.role, content: collapseWhitespace(m.content) })),
    temperature: request.temperature ?? 0.7,
    maxTokens: request.maxTokens ?? 512,
  };
  return JSON.stringify(normalized);
}

export function cacheKeyFor(request: UnifiedChatRequest): string {
  const normalized = normalizeRequest(request);
  const hash = createHash("sha256").update(normalized).digest("hex");
  return `cache:response:${hash}`;
}
