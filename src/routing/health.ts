import type { Redis } from "ioredis";

/**
 * Minimal circuit breaker: a provider that just failed (real error or
 * fault-injected) is deprioritized — not excluded — for a short cooldown,
 * so routing doesn't keep leading with a provider that's currently down.
 */
export class HealthTracker {
  constructor(
    private readonly redis: Redis,
    private readonly cooldownSeconds = 30,
  ) {}

  private key(provider: string): string {
    return `health:unhealthy:${provider}`;
  }

  async markUnhealthy(provider: string): Promise<void> {
    await this.redis.set(this.key(provider), "1", "EX", this.cooldownSeconds);
  }

  async markHealthy(provider: string): Promise<void> {
    await this.redis.del(this.key(provider));
  }

  async isUnhealthy(provider: string): Promise<boolean> {
    return (await this.redis.exists(this.key(provider))) === 1;
  }
}
