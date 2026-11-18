import { Request, Response, NextFunction, RequestHandler } from "express";
import type pg from "pg";
import { hashApiKey } from "../keys.js";
import { ApiKeyRecord } from "../types.js";
import { asyncHandler } from "../asyncHandler.js";
import { env } from "../../config/env.js";

interface CacheEntry {
  record: ApiKeyRecord;
  cachedAt: number;
}

const LAST_USED_WRITE_INTERVAL_MS = 60_000;

// Short-lived in-memory cache so every request does not cost a Postgres round trip. Revocation therefore takes
// effect within AUTH_CACHE_TTL_MS, or immediately on this instance via invalidateAuthCache().
const authCache = new Map<string, CacheEntry>();

export function invalidateAuthCache(keyId?: string): void {
  if (!keyId) {
    authCache.clear();
    return;
  }
  for (const [hash, entry] of authCache) {
    if (entry.record.id === keyId) authCache.delete(hash);
  }
}

export function checkKeyUsable(record: ApiKeyRecord, now: number = Date.now()): "ok" | "revoked" | "expired" {
  if (record.revoked_at) return "revoked";
  if (record.expires_at && new Date(record.expires_at).getTime() <= now) return "expired";
  return "ok";
}

export function createApiKeyAuthMiddleware(pool: pg.Pool, cacheTtlMs: number = env.AUTH_CACHE_TTL_MS): RequestHandler {
  const lastUsedWrites = new Map<string, number>();

  function touchLastUsed(id: string): void {
    const now = Date.now();
    if (now - (lastUsedWrites.get(id) ?? 0) < LAST_USED_WRITE_INTERVAL_MS) return;
    lastUsedWrites.set(id, now);
    pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [id]).catch(() => {
      lastUsedWrites.delete(id); // best effort; retry on a later request
    });
  }

  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }

    const rawKey = header.slice("Bearer ".length).trim();
    const keyHash = hashApiKey(rawKey);

    let entry = authCache.get(keyHash);
    if (!entry || Date.now() - entry.cachedAt > cacheTtlMs) {
      authCache.delete(keyHash);
      const result = await pool.query<ApiKeyRecord>("SELECT * FROM api_keys WHERE key_hash = $1", [keyHash]);
      const record = result.rows[0];
      if (!record) {
        res.status(401).json({ error: "invalid api key" });
        return;
      }
      entry = { record, cachedAt: Date.now() };
      authCache.set(keyHash, entry);
    }

    const state = checkKeyUsable(entry.record);
    if (state !== "ok") {
      res.status(401).json({ error: `api key ${state}` });
      return;
    }

    touchLastUsed(entry.record.id);
    req.apiKey = entry.record;
    next();
  });
}
