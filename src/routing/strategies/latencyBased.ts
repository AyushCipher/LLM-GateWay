import { LatencyTracker } from "../../observability/latencyTracker.js";
import { RoutingStrategy } from "./types.js";

/**
 * Ranks providers by rolling p50 latency (last 100 samples, see
 * LatencyTracker). Providers with no samples yet are ranked after all
 * providers with data — we don't have evidence they're fast, so we don't
 * claim they are; they'll still get tried (and start accumulating samples)
 * whenever every provider with data has failed.
 */
export class LatencyBasedStrategy implements RoutingStrategy {
  readonly name = "latency_based";

  constructor(private readonly latencyTracker: LatencyTracker) {}

  async orderProviders(available: string[]): Promise<string[]> {
    const withStats = await Promise.all(
      available.map(async (provider) => ({
        provider,
        ...(await this.latencyTracker.percentiles(provider)),
      })),
    );

    const known = withStats.filter((s) => s.count > 0).sort((a, b) => a.p50 - b.p50);
    const unknown = withStats.filter((s) => s.count === 0);

    return [...known.map((s) => s.provider), ...unknown.map((s) => s.provider)];
  }
}
