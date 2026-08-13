import type { Redis } from "ioredis";

/**
 * Fixed-window request counter. INCR + conditional EXPIRE run as a single
 * Lua script, so the check-and-increment is one atomic Redis operation —
 * there is no read-then-write gap a concurrent request could land in.
 *
 * This is a fixed window, not a sliding one: in the worst case, up to 2x
 * the limit can land across a window boundary (limit requests just before
 * expiry, limit again just after). That tradeoff is documented in the
 * README rather than hidden.
 */
const CHECK_REQUEST_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if current > tonumber(ARGV[1]) then
  return 0
else
  return 1
end
`;

/**
 * Atomically reserves an estimated token count against the per-window
 * budget, rolling back the reservation in the same script if it would
 * exceed the limit. Because the increment, the limit check, and the
 * rollback-on-reject all happen inside one Lua script, two concurrent
 * reservations can never both observe "under limit" for tokens that only
 * fit once — the same atomicity guarantee as the request counter above.
 */
const RESERVE_TOKENS_SCRIPT = `
local newval = redis.call('INCRBY', KEYS[1], ARGV[3])
if tonumber(newval) == tonumber(ARGV[3]) then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if tonumber(newval) > tonumber(ARGV[1]) then
  redis.call('DECRBY', KEYS[1], ARGV[3])
  return 0
else
  return 1
end
`;

/**
 * True per-call token usage is only known after the provider responds.
 * This adjusts the reserved estimate to the real number so the running
 * total stays accurate for subsequent requests in the same window.
 */
const ADJUST_TOKENS_SCRIPT = `
local delta = tonumber(ARGV[2]) - tonumber(ARGV[1])
redis.call('INCRBY', KEYS[1], delta)
return redis.call('GET', KEYS[1])
`;

export interface RateLimitConfig {
  requestsPerMinute: number;
  tokensPerMinute: number;
}

export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  /** Rough token estimate for the pre-call reservation (~4 chars/token). Adjusted to the actual count after the provider responds. */
  static estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }

  async checkRequestLimit(apiKeyId: string, limitPerMinute: number, windowSeconds = 60): Promise<boolean> {
    const key = `ratelimit:req:${apiKeyId}`;
    const result = (await this.redis.eval(CHECK_REQUEST_LIMIT_SCRIPT, 1, key, limitPerMinute, windowSeconds)) as number;
    return result === 1;
  }

  async reserveTokens(apiKeyId: string, estimatedTokens: number, limitPerMinute: number, windowSeconds = 60): Promise<boolean> {
    const key = `ratelimit:tok:${apiKeyId}`;
    const result = (await this.redis.eval(
      RESERVE_TOKENS_SCRIPT,
      1,
      key,
      limitPerMinute,
      windowSeconds,
      estimatedTokens,
    )) as number;
    return result === 1;
  }

  async adjustTokens(apiKeyId: string, estimatedTokens: number, actualTokens: number): Promise<void> {
    const key = `ratelimit:tok:${apiKeyId}`;
    await this.redis.eval(ADJUST_TOKENS_SCRIPT, 1, key, estimatedTokens, actualTokens);
  }
}
