import type { Redis } from "ioredis";

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  count: number;
}

const ZERO_PERCENTILES: Percentiles = { p50: 0, p95: 0, p99: 0, count: 0 };

/**
 * Bounded rolling-window latency sample store, used by the latency-based
 * routing strategy to rank providers and by /metrics to report percentiles.
 * Percentiles are computed exactly from the last `maxSamples` values on
 * every read (nearest-rank method) — not an HDR histogram or a running
 * approximation, which is fine at this sample size but wouldn't scale to
 * high cardinality without a real histogram implementation (see README
 * limitations).
 */
export class LatencyTracker {
  constructor(
    private readonly redis: Redis,
    private readonly maxSamples = 100,
  ) {}

  private key(label: string): string {
    return `latency:${label}`;
  }

  async record(label: string, latencyMs: number): Promise<void> {
    const key = this.key(label);
    await this.redis.multi().lpush(key, latencyMs).ltrim(key, 0, this.maxSamples - 1).exec();
  }

  async percentiles(label: string): Promise<Percentiles> {
    const raw = await this.redis.lrange(this.key(label), 0, -1);
    if (raw.length === 0) return ZERO_PERCENTILES;

    const sorted = raw.map(Number).sort((a: number, b: number) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;

    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), count: sorted.length };
  }

  async p50(label: string): Promise<number> {
    return (await this.percentiles(label)).p50;
  }
}
