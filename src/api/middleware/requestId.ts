import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { runWithTrace } from "../../observability/tracing.js";

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const traceId = req.header("x-trace-id") ?? randomUUID();
  res.setHeader("x-trace-id", traceId);
  runWithTrace(() => next(), traceId);
}
