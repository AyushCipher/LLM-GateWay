// Requires Redis (docker compose up -d redis). Not runnable offline: the Lua scripts execute inside Redis.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { createTestRedis } from "./testRedis.js";
import { RateLimiter } from "../../src/rateLimit/limiter.js";
import { BudgetEnforcer, budgetPeriod } from "../../src/cost/budget.js";

let redis: Redis;

describe("RateLimiter accounting hygiene (real Redis)", () => {
  let limiter: RateLimiter;
  beforeEach(async () => {
    redis = createTestRedis(6);
    await redis.flushdb();
    limiter = new RateLimiter(redis);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it("adjustTokens on a missing (expired) key is a no-op: no immortal negative key is created", async () => {
    await limiter.adjustTokens("gone", 1000, 10);
    expect(await redis.exists("ratelimit:tok:gone")).toBe(0);
  });

  it("adjustTokens on a live key applies the delta and keeps its TTL", async () => {
    await limiter.reserveTokens("live", 500, 10_000, 60);
    await limiter.adjustTokens("live", 500, 120);
    expect(Number(await redis.get("ratelimit:tok:live"))).toBe(120);
    const ttl = await redis.ttl("ratelimit:tok:live");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("re-sets a missing TTL and clamps the counter at zero", async () => {
    await redis.set("ratelimit:tok:nottl", "100"); // no TTL
    await limiter.adjustTokens("nottl", 500, 0); // delta -500 would go negative
    expect(Number(await redis.get("ratelimit:tok:nottl"))).toBe(0);
    expect(await redis.ttl("ratelimit:tok:nottl")).toBeGreaterThan(0);
  });

  it("a rejected request does not consume request quota", async () => {
    for (let i = 0; i < 3; i++) await limiter.checkRequestLimit("rq", 3, 60);
    for (let i = 0; i < 5; i++) expect(await limiter.checkRequestLimit("rq", 3, 60)).toBe(false);
    expect(Number(await redis.get("ratelimit:req:rq"))).toBe(3);
  });

  it("refundRequest gives a slot back, never below zero, and ignores missing keys", async () => {
    await limiter.checkRequestLimit("rf", 3, 60);
    await limiter.refundRequest("rf");
    await limiter.refundRequest("rf");
    expect(Number(await redis.get("ratelimit:req:rf"))).toBe(0);
    await limiter.refundRequest("never-seen");
    expect(await redis.exists("ratelimit:req:never-seen")).toBe(0);
  });
});

describe("BudgetEnforcer accounting hygiene (real Redis)", () => {
  let budget: BudgetEnforcer;
  beforeEach(async () => {
    redis = createTestRedis(7);
    await redis.flushdb();
    budget = new BudgetEnforcer(redis);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it("adjust on a missing key does nothing", async () => {
    await budget.adjust("ghost", 1, 0.2);
    expect(await redis.keys("budget:spend:ghost:*")).toEqual([]);
  });

  it("keys carry a TTL and are per calendar month", async () => {
    const r = await budget.reserve("cal", 0.1, 5, "hard_stop", new Date("2026-10-15T12:00:00Z"));
    expect(r.period).toBe("2026-10");
    const ttl = await redis.ttl("budget:spend:cal:2026-10");
    expect(ttl).toBeGreaterThan(0);
  });

  it("a new calendar month starts from zero spend", async () => {
    await budget.reserve("m", 4, 5, "hard_stop", new Date("2026-10-31T23:59:00Z"));
    const next = await budget.reserve("m", 4, 5, "hard_stop", new Date("2026-11-01T00:01:00Z"));
    expect(next.allowed).toBe(true);
    expect(next.currentSpendUsd).toBeCloseTo(4, 6);
  });

  it("adjust reconciles against the period the reservation was made in", async () => {
    const r = await budget.reserve("p", 1, 5, "hard_stop");
    await budget.adjust("p", 1, 0.25, r.period);
    expect(await budget.currentSpend("p", r.period)).toBeCloseTo(0.25, 6);
    expect(await budget.currentSpend("p", budgetPeriod(new Date("2001-01-01")))).toBe(0);
  });

  it("clamps at zero rather than leaving a negative balance", async () => {
    const r = await budget.reserve("neg", 0.1, 5, "hard_stop");
    await budget.adjust("neg", 5, 0, r.period); // over-refund
    expect(await budget.currentSpend("neg", r.period)).toBe(0);
  });
});
