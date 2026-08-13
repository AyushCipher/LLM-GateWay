import type { Redis } from "ioredis";

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
