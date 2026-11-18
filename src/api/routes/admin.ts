import { Router as ExpressRouter, Request, Response } from "express";
import { z } from "zod";
import type { Redis } from "ioredis";
import { asyncHandler } from "../asyncHandler.js";
import { setFault, getFault } from "../../providers/faultInjector.js";

const faultSchema = z.object({
  provider: z.string().min(1),
  mode: z.enum(["timeout", "error_5xx", "rate_limit", "clear"]),
});

export function createAdminRouter(redis: Redis): ExpressRouter {
  const router = ExpressRouter();

  router.post("/admin/fault-injection", asyncHandler(async (req: Request, res: Response) => {
    const parsed = faultSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request body", details: parsed.error.flatten() });
      return;
    }
    await setFault(redis, parsed.data.provider, parsed.data.mode);
    res.json({ provider: parsed.data.provider, mode: parsed.data.mode });
  }));

  router.get("/admin/fault-injection/:provider", asyncHandler(async (req: Request, res: Response) => {
    const provider = req.params.provider;
    if (!provider) {
      res.status(400).json({ error: "provider param is required" });
      return;
    }
    const mode = await getFault(redis, provider);
    res.json({ provider, mode: mode ?? "clear" });
  }));

  return router;
}
