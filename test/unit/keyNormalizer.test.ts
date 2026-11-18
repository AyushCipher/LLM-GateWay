import { describe, it, expect } from "vitest";
import { cacheKeyFor } from "../../src/cache/keyNormalizer.js";
import { UnifiedChatRequest } from "../../src/providers/types.js";

function req(overrides: Partial<UnifiedChatRequest> = {}): UnifiedChatRequest {
  return {
    model: "default",
    messages: [{ role: "user", content: "Hello there" }],
    temperature: 0.7,
    maxTokens: 512,
    ...overrides,
  };
}

describe("cacheKeyFor", () => {
  it("is deterministic for identical requests", () => {
    expect(cacheKeyFor(req())).toBe(cacheKeyFor(req()));
  });

  it("collapses whitespace differences", () => {
    const a = cacheKeyFor(req({ messages: [{ role: "user", content: "Hello   there" }] }));
    const b = cacheKeyFor(req({ messages: [{ role: "user", content: "  Hello there  " }] }));
    expect(a).toBe(b);
  });

  it("does not collapse casing differences", () => {
    const a = cacheKeyFor(req({ messages: [{ role: "user", content: "Hello there" }] }));
    const b = cacheKeyFor(req({ messages: [{ role: "user", content: "hello there" }] }));
    expect(a).not.toBe(b);
  });

  it("differs when model changes", () => {
    const a = cacheKeyFor(req({ model: "default" }));
    const b = cacheKeyFor(req({ model: "other-model" }));
    expect(a).not.toBe(b);
  });

  it("differs when temperature changes", () => {
    const a = cacheKeyFor(req({ temperature: 0.2 }));
    const b = cacheKeyFor(req({ temperature: 0.9 }));
    expect(a).not.toBe(b);
  });

  it("differs when message content changes", () => {
    const a = cacheKeyFor(req({ messages: [{ role: "user", content: "Hello there" }] }));
    const b = cacheKeyFor(req({ messages: [{ role: "user", content: "Goodbye there" }] }));
    expect(a).not.toBe(b);
  });

  it("differs when maxTokens changes", () => {
    expect(cacheKeyFor(req({ maxTokens: 100 }))).not.toBe(cacheKeyFor(req({ maxTokens: 900 })));
  });

  it("differs per tenant", () => {
    expect(cacheKeyFor(req({ tenantId: "tenant-a" }))).not.toBe(cacheKeyFor(req({ tenantId: "tenant-b" })));
    expect(cacheKeyFor(req({ tenantId: "tenant-a" }))).not.toBe(cacheKeyFor(req()));
  });

  it("differs when the model scope differs (default model is provider-specific)", () => {
    expect(cacheKeyFor(req(), "default@groq:a")).not.toBe(cacheKeyFor(req(), "default@gemini:b"));
  });
});
