import type { Redis } from "ioredis";

const RESERVE_BUDGET_SCRIPT = `
local newval = tonumber(redis.call('INCRBYFLOAT', KEYS[1], ARGV[3]))
local ttl = redis.call('TTL', KEYS[1])
if ttl == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if newval > tonumber(ARGV[1]) then
  redis.call('INCRBYFLOAT', KEYS[1], '-' .. ARGV[3])
  return 0
else
  return 1
end
`;

const ADJUST_BUDGET_SCRIPT = `
local delta = tonumber(ARGV[2]) - tonumber(ARGV[1])
redis.call('INCRBYFLOAT', KEYS[1], tostring(delta))
return redis.call('GET', KEYS[1])
`;

export const DEFAULT_BUDGET_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export type BudgetMode = "hard_stop" | "soft_warn";

export interface BudgetCheckResult {
  allowed: boolean;
  currentSpendUsd: number;
  capUsd: number;
  mode: BudgetMode;
}

export class BudgetEnforcer {
  constructor(private readonly redis: Redis) {}

  private key(apiKeyId: string): string {
    return `budget:spend:${apiKeyId}`;
  }

  async reserve(apiKeyId: string, estimatedCostUsd: number, capUsd: number, mode: BudgetMode): Promise<BudgetCheckResult> {
    const key = this.key(apiKeyId);
    const allowedRaw = (await this.redis.eval(
      RESERVE_BUDGET_SCRIPT,
      1,
      key,
      capUsd,
      DEFAULT_BUDGET_WINDOW_SECONDS,
      estimatedCostUsd,
    )) as number;

    if (mode === "soft_warn" && allowedRaw === 0) {
      await this.redis.incrbyfloat(key, estimatedCostUsd);
    }

    const currentSpendUsd = Number((await this.redis.get(key)) ?? "0");
    return {
      allowed: mode === "soft_warn" ? true : allowedRaw === 1,
      currentSpendUsd,
      capUsd,
      mode,
    };
  }

  async adjust(apiKeyId: string, estimatedCostUsd: number, actualCostUsd: number): Promise<void> {
    const key = this.key(apiKeyId);
    await this.redis.eval(ADJUST_BUDGET_SCRIPT, 1, key, estimatedCostUsd, actualCostUsd);
  }

  async currentSpend(apiKeyId: string): Promise<number> {
    return Number((await this.redis.get(this.key(apiKeyId))) ?? "0");
  }
}
