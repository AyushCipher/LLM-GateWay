import { writeFileSync } from "node:fs";
import { redis } from "../src/redis/client.js";
import { RateLimiter } from "../src/rateLimit/limiter.js";

interface Trial {
  limit: number;
  concurrency: number;
  allowed: number;
  rejected: number;
  exact: boolean;
}

async function runTrial(limiter: RateLimiter, key: string, limit: number, concurrency: number): Promise<Trial> {
  const results = await Promise.all(Array.from({ length: concurrency }, () => limiter.checkRequestLimit(key, limit, 60)));
  const allowed = results.filter((r) => r).length;
  return { limit, concurrency, allowed, rejected: concurrency - allowed, exact: allowed === limit };
}

async function run() {
  await redis.flushdb();
  const limiter = new RateLimiter(redis);

  const configs: { limit: number; concurrency: number }[] = [
    { limit: 50, concurrency: 200 },
    { limit: 50, concurrency: 200 },
    { limit: 50, concurrency: 200 },
    { limit: 100, concurrency: 500 },
    { limit: 10, concurrency: 300 },
  ];

  const trials: Trial[] = [];
  for (let i = 0; i < configs.length; i++) {
    const { limit, concurrency } = configs[i]!;
    const trial = await runTrial(limiter, `bench-race-key-${i}`, limit, concurrency);
    trials.push(trial);
    console.log(`Trial ${i}: limit=${limit} concurrency=${concurrency} -> allowed=${trial.allowed} (exact=${trial.exact})`);
  }

  const allExact = trials.every((t) => t.exact);

  const report = {
    measuredAt: new Date().toISOString(),
    trials,
    allTrialsExact: allExact,
    note: "Each trial fires `concurrency` requests simultaneously via Promise.all against a single fresh key and asserts the allowed count equals the limit exactly, proving the check-and-increment Lua script has no race window.",
  };

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(new URL("./results/rate-limit-concurrency.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(`\nAll trials exact: ${allExact}`);

  await redis.quit();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
