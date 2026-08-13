import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { createTestRedis } from "./testRedis.js";
import { RateLimiter } from "../../src/rateLimit/limiter.js";

let redis: Redis;
let limiter: RateLimiter;

describe("RateLimiter concurrency correctness (real Redis)", () => {
  beforeEach(async () => {
    redis = createTestRedis(3);
    await redis.flushdb();
    limiter = new RateLimiter(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("allows exactly `limit` requests when 200 concurrent requests race for a 50/min budget", async () => {
    const limit = 50;
    const concurrency = 200;
    const key = "race-key-1";

    const results = await Promise.all(
      Array.from({ length: concurrency }, () => limiter.checkRequestLimit(key, limit, 60)),
    );

    const allowed = results.filter((r) => r === true).length;
    const rejected = results.filter((r) => r === false).length;

    expect(allowed).toBe(limit);
    expect(rejected).toBe(concurrency - limit);
  });

  it("holds under repeated trials (no flakiness from the race)", async () => {
    const limit = 30;
    const concurrency = 150;

    for (let trial = 0; trial < 5; trial++) {
      const key = `race-key-trial-${trial}`;
      const results = await Promise.all(
        Array.from({ length: concurrency }, () => limiter.checkRequestLimit(key, limit, 60)),
      );
      const allowed = results.filter((r) => r === true).length;
      expect(allowed).toBe(limit);
    }
  });

  it("token reservation never lets concurrent reservations overshoot the budget", async () => {
    const limitTokens = 1000;
    const key = "race-key-tokens";
    const reservationSize = 50;
    const concurrency = 40;

    const results = await Promise.all(
      Array.from({ length: concurrency }, () => limiter.reserveTokens(key, reservationSize, limitTokens, 60)),
    );

    const allowedCount = results.filter((r) => r === true).length;
    const totalReserved = allowedCount * reservationSize;

    expect(totalReserved).toBeLessThanOrEqual(limitTokens);
    expect(allowedCount).toBe(20);
  });

  it("adjustTokens reconciles the reservation to actual usage", async () => {
    const key = "adjust-key";
    const limitTokens = 1000;
    await limiter.reserveTokens(key, 100, limitTokens, 60);
    await limiter.adjustTokens(key, 100, 40);

    const remainingRaw = await redis.get(`ratelimit:tok:${key}`);
    expect(Number(remainingRaw)).toBe(40);
  });
});
