import { Router as ExpressRouter, Request, Response } from "express";

export function createHealthRouter(): ExpressRouter {
  const router = ExpressRouter();
  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", uptimeSeconds: process.uptime() });
  });
  return router;
}
