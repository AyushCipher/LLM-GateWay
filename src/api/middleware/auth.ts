import { Request, Response, NextFunction } from "express";
import type pg from "pg";
import { hashApiKey } from "../keys.js";
import { ApiKeyRecord } from "../types.js";

export function createApiKeyAuthMiddleware(pool: pg.Pool) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }

    const rawKey = header.slice("Bearer ".length).trim();
    const keyHash = hashApiKey(rawKey);

    const result = await pool.query<ApiKeyRecord>("SELECT * FROM api_keys WHERE key_hash = $1", [keyHash]);
    if (result.rows.length === 0) {
      res.status(401).json({ error: "invalid api key" });
      return;
    }

    req.apiKey = result.rows[0];
    next();
  };
}
