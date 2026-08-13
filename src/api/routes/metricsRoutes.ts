import { Router as ExpressRouter, Request, Response } from "express";
import type { Redis } from "ioredis";
import { getMetricsText, getMetricsJson } from "../../observability/metrics.js";

export function createMetricsRouter(redis: Redis, providerNames: string[]): ExpressRouter {
  const router = ExpressRouter();

  router.get("/metrics", async (_req: Request, res: Response) => {
    res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(await getMetricsText());
  });

  router.get("/metrics/json", async (_req: Request, res: Response) => {
    res.json(await getMetricsJson(redis, providerNames));
  });

  return router;
}
