import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { createTestRedis } from "./testRedis.js";
import { BudgetEnforcer } from "../../src/cost/budget.js";

let redis: Redis;
let budget: BudgetEnforcer;

describe("BudgetEnforcer (real Redis)", () => {
  beforeEach(async () => {
    redis = createTestRedis(1);
    await redis.flushdb();
    budget = new BudgetEnforcer(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("allows spend under the cap and rejects once it would be exceeded (hard_stop)", async () => {
    const key = "budget-key-1";
    const cap = 1.0;

    const first = await budget.reserve(key, 0.4, cap, "hard_stop");
    expect(first.allowed).toBe(true);

    const second = await budget.reserve(key, 0.4, cap, "hard_stop");
    expect(second.allowed).toBe(true);

    const third = await budget.reserve(key, 0.4, cap, "hard_stop"); // 1.2 > 1.0
    expect(third.allowed).toBe(false);
    expect(third.currentSpendUsd).toBeCloseTo(0.8, 6); // rejected reservation was rolled back
  });

  it("never lets concurrent reservations push spend past the cap in hard_stop mode", async () => {
    const key = "budget-key-race";
    const cap = 1.0;
    const perRequest = 0.05;
    const concurrency = 40; // 40 * 0.05 = 2.0, double the cap

    const results = await Promise.all(
      Array.from({ length: concurrency }, () => budget.reserve(key, perRequest, cap, "hard_stop")),
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    const finalSpend = await budget.currentSpend(key);

    expect(allowedCount).toBe(20); // 20 * 0.05 = 1.0 exactly fits
    expect(finalSpend).toBeCloseTo(1.0, 6);
  });

  it("soft_warn mode always allows but still reports the cap as exceeded", async () => {
    const key = "budget-key-2";
    const cap = 0.5;

    await budget.reserve(key, 0.4, cap, "soft_warn");
    const second = await budget.reserve(key, 0.4, cap, "soft_warn");

    expect(second.allowed).toBe(true);
    expect(second.currentSpendUsd).toBeCloseTo(0.8, 6);
    expect(second.currentSpendUsd).toBeGreaterThan(second.capUsd);
  });

  it("adjust reconciles reserved estimate to actual cost", async () => {
    const key = "budget-key-3";
    await budget.reserve(key, 0.1, 5, "hard_stop");
    await budget.adjust(key, 0.1, 0.03);

    const spend = await budget.currentSpend(key);
    expect(spend).toBeCloseTo(0.03, 6);
  });
});
