import { describe, expect, it } from "vitest";
import {
  UnknownModelPricingError,
  computeCostUsd,
  estimateWorstCaseCostUsd,
  getPricing,
  registerPricing,
} from "../../src/cost/pricing.js";
import { budgetPeriod, secondsUntilPeriodEnd } from "../../src/cost/budget.js";
import { assertSafeConfig, DEFAULT_ADMIN_SECRET } from "../../src/config/env.js";

describe("pricing fails closed", () => {
  it("throws for an unknown model instead of pricing it at 0", () => {
    expect(() => getPricing("groq", "mystery-model")).toThrow(UnknownModelPricingError);
    expect(() => computeCostUsd("nope", "nope", { promptTokens: 1, completionTokens: 1, totalTokens: 2 })).toThrow(UnknownModelPricingError);
  });

  it("allows an explicitly registered price", () => {
    registerPricing("custom", "m1", { inputPerMillion: 1, outputPerMillion: 2 });
    expect(computeCostUsd("custom", "m1", { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 })).toBe(3);
  });

  it("worst-case estimate is the max over the chain and includes input AND output", () => {
    const est = estimateWorstCaseCostUsd(
      [
        { provider: "groq", model: "llama-3.1-8b-instant" }, // 0.05 / 0.08
        { provider: "gemini", model: "gemini-flash-lite-latest" }, // 0.3 / 2.5
      ],
      1_000_000,
      1_000_000,
    );
    expect(est).toBeCloseTo(0.3 + 2.5, 9);
  });

  it("worst-case estimate throws if any provider in the chain is unpriced", () => {
    expect(() => estimateWorstCaseCostUsd([{ provider: "groq", model: "llama-3.1-8b-instant" }, { provider: "groq", model: "x" }], 1, 1)).toThrow(
      UnknownModelPricingError,
    );
  });
});

describe("budget calendar month", () => {
  it("uses the UTC calendar month as the period", () => {
    expect(budgetPeriod(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
    expect(budgetPeriod(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
    expect(budgetPeriod(new Date("2026-01-05T12:00:00Z"))).toBe("2026-01");
  });

  it("computes seconds to the end of the month, including December rollover", () => {
    expect(secondsUntilPeriodEnd(new Date("2026-10-31T23:59:00Z"))).toBe(60);
    expect(secondsUntilPeriodEnd(new Date("2026-12-31T23:00:00Z"))).toBe(3600);
  });
});

describe("startup guard", () => {
  it("rejects the default or a short ADMIN_SECRET in production", () => {
    expect(() => assertSafeConfig({ NODE_ENV: "production", ADMIN_SECRET: DEFAULT_ADMIN_SECRET })).toThrow(/default/);
    expect(() => assertSafeConfig({ NODE_ENV: "production", ADMIN_SECRET: "short" })).toThrow(/16/);
  });

  it("accepts a strong secret in production and anything in development", () => {
    expect(() => assertSafeConfig({ NODE_ENV: "production", ADMIN_SECRET: "a-long-random-secret-value" })).not.toThrow();
    expect(() => assertSafeConfig({ NODE_ENV: "development", ADMIN_SECRET: DEFAULT_ADMIN_SECRET })).not.toThrow();
  });
});
