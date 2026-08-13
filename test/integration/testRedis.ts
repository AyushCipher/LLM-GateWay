import { Redis } from "ioredis";
import { env } from "../../src/config/env.js";

/**
 * Each test FILE gets its own logical Redis DB (1-15), separate from the
 * dev server (DB 0) and from each other. Vitest runs test files in
 * parallel, and several of these suites call flushdb() in beforeEach —
 * sharing one DB index across files let one file's flush wipe another
 * file's in-flight concurrency counters mid-race, producing flaky
 * over-counts. Each file passing a distinct index avoids that entirely.
 */
export function createTestRedis(dbIndex: number): Redis {
  const url = new URL(env.REDIS_URL);
  url.pathname = `/${dbIndex}`;
  return new Redis(url.toString());
}
