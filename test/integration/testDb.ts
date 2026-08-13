import pg from "pg";
import { randomUUID } from "node:crypto";
import { env } from "../../src/config/env.js";

export function createTestPool(): pg.Pool {
  return new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
}

/** Inserts a throwaway api_keys row (FK target for requests) and returns its id. */
export async function insertTestApiKey(pool: pg.Pool, overrides: Partial<{ budgetUsdMonthly: number }> = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO api_keys (id, key_hash, key_prefix, name, budget_usd_monthly, requests_per_minute, tokens_per_minute)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, `test-hash-${id}`, "test_", "test-key", overrides.budgetUsdMonthly ?? 5, 60, 40000],
  );
  return id;
}
