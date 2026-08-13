import { timingSafeEqual } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { env } from "../../config/env.js";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header("x-admin-secret");
  if (!provided || !safeEqual(provided, env.ADMIN_SECRET)) {
    res.status(401).json({ error: "invalid or missing admin secret" });
    return;
  }
  next();
}
