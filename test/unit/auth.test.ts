import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { NextFunction, Request, Response } from "express";
import { checkKeyUsable, createApiKeyAuthMiddleware, invalidateAuthCache } from "../../src/api/middleware/auth.js";
import { asyncHandler } from "../../src/api/asyncHandler.js";
import { ApiKeyRecord } from "../../src/api/types.js";

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: "k1",
    key_hash: "h",
    key_prefix: "lg_",
    name: "n",
    budget_usd_monthly: "5",
    budget_mode: "hard_stop",
    requests_per_minute: 60,
    tokens_per_minute: 1000,
    created_at: new Date().toISOString(),
    revoked_at: null,
    expires_at: null,
    last_used_at: null,
    ...overrides,
  };
}

function fakePool(rec: ApiKeyRecord | null) {
  const calls = { select: 0, update: 0 };
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith("SELECT")) {
        calls.select++;
        return { rows: rec ? [rec] : [] };
      }
      calls.update++;
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  return { pool, calls, setRecord: (r: ApiKeyRecord) => (rec = r) };
}

async function call(mw: ReturnType<typeof createApiKeyAuthMiddleware>, token = "lg_abc") {
  let status = 0;
  let nextArg: unknown = "not-called";
  const req = { header: (n: string) => (n === "authorization" ? `Bearer ${token}` : undefined) } as unknown as Request;
  const res = {
    status(c: number) {
      status = c;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = (e?: unknown) => {
    nextArg = e;
  };
  mw(req, res, next);
  await new Promise((r) => setTimeout(r, 20));
  return { status, nextArg, req };
}

describe("api key lifecycle", () => {
  it("checkKeyUsable flags revoked and expired keys", () => {
    expect(checkKeyUsable(record())).toBe("ok");
    expect(checkKeyUsable(record({ revoked_at: new Date().toISOString() }))).toBe("revoked");
    expect(checkKeyUsable(record({ expires_at: new Date(Date.now() - 1000).toISOString() }))).toBe("expired");
    expect(checkKeyUsable(record({ expires_at: new Date(Date.now() + 60_000).toISOString() }))).toBe("ok");
  });

  it("401s a revoked key and an expired key", async () => {
    invalidateAuthCache();
    expect((await call(createApiKeyAuthMiddleware(fakePool(record({ revoked_at: "2026-01-01T00:00:00Z" })).pool, 0), "lg_r")).status).toBe(401);
    invalidateAuthCache();
    expect((await call(createApiKeyAuthMiddleware(fakePool(record({ expires_at: "2020-01-01T00:00:00Z" })).pool, 0), "lg_e")).status).toBe(401);
  });

  it("caches lookups briefly, and invalidateAuthCache makes revocation immediate", async () => {
    invalidateAuthCache();
    const { pool, calls, setRecord } = fakePool(record());
    const mw = createApiKeyAuthMiddleware(pool, 60_000);

    expect((await call(mw, "lg_cached")).nextArg).toBeUndefined();
    expect((await call(mw, "lg_cached")).nextArg).toBeUndefined();
    expect(calls.select).toBe(1); // second request served from memory

    setRecord(record({ revoked_at: "2026-01-01T00:00:00Z" }));
    expect((await call(mw, "lg_cached")).status).toBe(0); // stale cache still allows it within the TTL...
    invalidateAuthCache("k1");
    expect((await call(mw, "lg_cached")).status).toBe(401); // ...until invalidated
  });

  it("throttles last_used_at writes", async () => {
    invalidateAuthCache();
    const { pool, calls } = fakePool(record());
    const mw = createApiKeyAuthMiddleware(pool, 60_000);
    await call(mw, "lg_used");
    await call(mw, "lg_used");
    await call(mw, "lg_used");
    expect(calls.update).toBe(1);
  });

  it("forwards a database failure to next(err) instead of leaving the request hanging", async () => {
    invalidateAuthCache();
    const pool = {
      query: async () => {
        throw new Error("db down");
      },
    } as unknown as pg.Pool;
    const result = await call(createApiKeyAuthMiddleware(pool, 0), "lg_dberr");
    expect(result.nextArg).toBeInstanceOf(Error);
    expect((result.nextArg as Error).message).toBe("db down");
  });
});

describe("asyncHandler", () => {
  it("passes rejections to next", async () => {
    let got: unknown;
    asyncHandler(async () => {
      throw new Error("async fail");
    })({} as Request, {} as Response, ((e: unknown) => (got = e)) as NextFunction);
    await new Promise((r) => setTimeout(r, 5));
    expect((got as Error).message).toBe("async fail");
  });
});
