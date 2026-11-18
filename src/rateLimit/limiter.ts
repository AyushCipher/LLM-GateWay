import type { Redis } from "ioredis";
import { estimateTokens } from "../cost/tokenEstimate.js";

// Rejected requests must not burn quota: the script undoes its own INCR when over the limit.
const CHECK_REQUEST_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 or redis.call('TTL', KEYS[1]) == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if current > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
else
  return 1
end
`;

// Give back one request slot (used when a later preflight stage rejects). Only touches an existing key.
const REFUND_REQUEST_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
local current = redis.call('DECR', KEYS[1])
if current < 0 then
  redis.call('SET', KEYS[1], 0, 'KEEPTTL')
end
return 1
`;

const RESERVE_TOKENS_SCRIPT = `
local newval = redis.call('INCRBY', KEYS[1], ARGV[3])
if redis.call('TTL', KEYS[1]) == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if tonumber(newval) > tonumber(ARGV[1]) then
  redis.call('DECRBY', KEYS[1], ARGV[3])
  return 0
else
  return 1
end
`;

// Apply the delta only if the window key still exists. If it expired, the reservation it refers to was
// already forgotten with it, and INCRBY on a missing key would recreate an immortal (possibly negative) counter.
// The TTL is re-set if somehow absent, and the counter is clamped at 0.
const ADJUST_TOKENS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return -1
end
local delta = tonumber(ARGV[2]) - tonumber(ARGV[1])
local newval = redis.call('INCRBY', KEYS[1], delta)
if redis.call('TTL', KEYS[1]) == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
if newval < 0 then
  redis.call('SET', KEYS[1], 0, 'KEEPTTL')
  return 0
end
return newval
`;

export interface RateLimitConfig {
  requestsPerMinute: number;
  tokensPerMinute: number;
}

export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  static estimateTokens(text: string): number {
    return estimateTokens(text);
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

  async refundRequest(apiKeyId: string): Promise<void> {
    await this.redis.eval(REFUND_REQUEST_SCRIPT, 1, `ratelimit:req:${apiKeyId}`);
  }

  async adjustTokens(apiKeyId: string, estimatedTokens: number, actualTokens: number, windowSeconds = 60): Promise<void> {
    const key = `ratelimit:tok:${apiKeyId}`;
    await this.redis.eval(ADJUST_TOKENS_SCRIPT, 1, key, estimatedTokens, actualTokens, windowSeconds);
  }
}
