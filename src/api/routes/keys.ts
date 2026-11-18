import { Router as ExpressRouter, Request, Response } from "express";
import { z } from "zod";
import type pg from "pg";
import { generateApiKey } from "../keys.js";
import { env } from "../../config/env.js";
import { asyncHandler } from "../asyncHandler.js";
import { invalidateAuthCache } from "../middleware/auth.js";

const createKeySchema = z.object({
  name: z.string().min(1),
  budgetUsdMonthly: z.number().positive().optional(),
  budgetMode: z.enum(["hard_stop", "soft_warn"]).optional(),
  requestsPerMinute: z.number().int().positive().optional(),
  tokensPerMinute: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
});

export function createKeysRouter(pool: pg.Pool): ExpressRouter {
  const router = ExpressRouter();

  router.post("/v1/keys", asyncHandler(async (req: Request, res: Response) => {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request body", details: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;
    const { rawKey, keyHash, keyPrefix } = generateApiKey();

    const budgetUsdMonthly = body.budgetUsdMonthly ?? env.DEFAULT_BUDGET_USD_MONTHLY;
    const budgetMode = body.budgetMode ?? env.BUDGET_MODE;
    const requestsPerMinute = body.requestsPerMinute ?? env.DEFAULT_REQUESTS_PER_MINUTE;
    const tokensPerMinute = body.tokensPerMinute ?? env.DEFAULT_TOKENS_PER_MINUTE;

    const result = await pool.query(
      `INSERT INTO api_keys (key_hash, key_prefix, name, budget_usd_monthly, budget_mode, requests_per_minute, tokens_per_minute, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, budget_usd_monthly, budget_mode, requests_per_minute, tokens_per_minute, created_at, expires_at`,
      [keyHash, keyPrefix, body.name, budgetUsdMonthly, budgetMode, requestsPerMinute, tokensPerMinute, body.expiresAt ?? null],
    );

    res.status(201).json({
      apiKey: rawKey, // shown once; only the hash is stored
      ...result.rows[0],
    });
  }));

  router.delete(
    "/v1/keys/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const result = await pool.query(
        "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING id, revoked_at",
        [req.params.id],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "api key not found" });
        return;
      }
      invalidateAuthCache(req.params.id);
      res.json({ ...result.rows[0] });
    }),
  );

  return router;
}
