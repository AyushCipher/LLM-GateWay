import { Redis } from "ioredis";
import { env } from "../../src/config/env.js";

export function createTestRedis(dbIndex: number): Redis {
  const url = new URL(env.REDIS_URL);
  url.pathname = `/${dbIndex}`;
  return new Redis(url.toString());
}
