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

// Apply the delta only if the period key still exists (never resurrect an expired key as an immortal,
// possibly negative counter); re-set the TTL if absent and clamp at 0.
const ADJUST_BUDGET_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return '-1'
end
local delta = tonumber(ARGV[2]) - tonumber(ARGV[1])
local newval = tonumber(redis.call('INCRBYFLOAT', KEYS[1], tostring(delta)))
if redis.call('TTL', KEYS[1]) == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
if newval < 0 then
  redis.call('SET', KEYS[1], '0', 'KEEPTTL')
end
return redis.call('GET', KEYS[1])
`;

/**
 * Budgets are per UTC calendar month ("monthly" means calendar month, not a rolling 30 days). Each month has
 * its own Redis key, which is kept for a grace period after month end and then expires on its own.
 */
const PERIOD_GRACE_SECONDS = 7 * 24 * 60 * 60;

export function budgetPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function secondsUntilPeriodEnd(now: Date = new Date()): number {
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((nextMonth - now.getTime()) / 1000));
}

export type BudgetMode = "hard_stop" | "soft_warn";

export interface BudgetCheckResult {
  allowed: boolean;
  currentSpendUsd: number;
  capUsd: number;
  mode: BudgetMode;
  /** Calendar month (UTC, YYYY-MM) the reservation was made in; pass back to adjust(). */
  period: string;
}

export class BudgetEnforcer {
  constructor(private readonly redis: Redis) {}

  private key(apiKeyId: string, period: string): string {
    return `budget:spend:${apiKeyId}:${period}`;
  }

  async reserve(
    apiKeyId: string,
    estimatedCostUsd: number,
    capUsd: number,
    mode: BudgetMode,
    now: Date = new Date(),
  ): Promise<BudgetCheckResult> {
    const period = budgetPeriod(now);
    const key = this.key(apiKeyId, period);
    const allowedRaw = (await this.redis.eval(
      RESERVE_BUDGET_SCRIPT,
      1,
      key,
      capUsd,
      secondsUntilPeriodEnd(now) + PERIOD_GRACE_SECONDS,
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
      period,
    };
  }

  /** Reconcile a reservation to its actual cost. `period` must be the one returned by reserve(). */
  async adjust(apiKeyId: string, estimatedCostUsd: number, actualCostUsd: number, period: string = budgetPeriod()): Promise<void> {
    await this.redis.eval(
      ADJUST_BUDGET_SCRIPT,
      1,
      this.key(apiKeyId, period),
      estimatedCostUsd,
      actualCostUsd,
      secondsUntilPeriodEnd() + PERIOD_GRACE_SECONDS,
    );
  }

  async currentSpend(apiKeyId: string, period: string = budgetPeriod()): Promise<number> {
    return Number((await this.redis.get(this.key(apiKeyId, period))) ?? "0");
  }
}
