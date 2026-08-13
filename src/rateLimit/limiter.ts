import type { Redis } from "ioredis";

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
