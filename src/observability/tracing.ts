import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";

interface TraceContext {
  traceId: string;
}

const als = new AsyncLocalStorage<TraceContext>();

export function runWithTrace<T>(fn: () => T, traceId: string = randomUUID()): T {
  return als.run({ traceId }, fn);
}

export function getTraceId(): string {
  return als.getStore()?.traceId ?? "no-trace";
}

export function traceLog(event: string, fields: Record<string, unknown> = {}): void {
  logger.info({ traceId: getTraceId(), event, ...fields });
}

export function traceWarn(event: string, fields: Record<string, unknown> = {}): void {
  logger.warn({ traceId: getTraceId(), event, ...fields });
}
