import http from "node:http";
import { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createChatRouter } from "../../src/api/routes/chat.js";
import { RecordRequestParams } from "../../src/cost/costTracker.js";
import { computeCostUsd } from "../../src/cost/pricing.js";
import { ApiKeyRecord } from "../../src/api/types.js";
import { FakeAdapter, buildRouter, sleep, waitForever } from "../helpers/fakes.js";

const apiKey: ApiKeyRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  key_hash: "h",
  key_prefix: "lg_",
  name: "t",
  budget_usd_monthly: "5",
  budget_mode: "hard_stop",
  requests_per_minute: 60,
  tokens_per_minute: 40000,
  created_at: new Date().toISOString(),
};

/** In-memory accounting with the same reserve/adjust semantics as the Redis implementation. */
class FakeAccounting {
  requests = 0;
  tokens = 0;
  spend = 0;
  tokenLimit = Infinity;
  budgetCap = Infinity;
  records: RecordRequestParams[] = [];

  rateLimiter = {
    checkRequestLimit: async () => {
      this.requests++;
      return true;
    },
    refundRequest: async () => {
      this.requests--;
    },
    reserveTokens: async (_id: string, est: number) => {
      if (this.tokens + est > this.tokenLimit) return false;
      this.tokens += est;
      return true;
    },
    adjustTokens: async (_id: string, est: number, actual: number) => {
      this.tokens += actual - est;
    },
  };
  budgetEnforcer = {
    reserve: async (_id: string, est: number) => {
      if (this.spend + est > this.budgetCap) return { allowed: false, currentSpendUsd: this.spend, capUsd: this.budgetCap, period: "2026-10" };
      this.spend += est;
      return { allowed: true, currentSpendUsd: this.spend, capUsd: this.budgetCap, period: "2026-10" };
    },
    adjust: async (_id: string, est: number, actual: number) => {
      this.spend += actual - est;
    },
  };
  costTracker = {
    recordRequest: async (p: RecordRequestParams) => {
      this.records.push(p);
    },
  };
}

let server: http.Server | undefined;
afterEach(() => {
  server?.closeAllConnections?.();
  server?.close();
  server = undefined;
});

async function start(adapters: FakeAdapter[], acct: FakeAccounting, idleMs?: number): Promise<number> {
  const router = buildRouter(adapters, { streamIdleTimeoutMs: idleMs });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.apiKey = apiKey;
    next();
  });
  app.use(
    createChatRouter({
      pool: undefined as never,
      router,
      rateLimiter: acct.rateLimiter as never,
      budgetEnforcer: acct.budgetEnforcer as never,
      costTracker: acct.costTracker as never,
      registry: new Map(adapters.map((a) => [a.name, a])),
    }),
  );
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal server error" });
  });
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, r));
  return (server.address() as AddressInfo).port;
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

const body = JSON.stringify({ messages: [{ role: "user", content: "write something long" }], stream: true, maxTokens: 200 });

describe("chat route reservation reconciliation", () => {
  it("client disconnect mid-stream: aborts upstream, charges the partial (estimated) usage, refunds the rest, records partial_output", async () => {
    const acct = new FakeAccounting();
    const adapter = new FakeAdapter("groq", "llama-3.1-8b-instant", async function* (signal) {
      yield { delta: "partial text from upstream" };
      await waitForever(signal);
    });
    const port = await start([adapter], acct);

    await new Promise<void>((resolve, reject) => {
      const req = http.request({ port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } }, (res) => {
        res.once("data", () => {
          req.destroy(); // the client walks away after the first chunk
          resolve();
        });
      });
      req.on("error", () => {});
      req.write(body);
      req.end();
      setTimeout(() => reject(new Error("no data received")), 3000);
    });

    await waitFor(() => acct.records.length === 1);

    const rec = acct.records[0]!;
    expect(rec.status).toBe("aborted");
    expect(rec.partialOutput).toBe(true);
    expect(rec.usageEstimated).toBe(true);
    expect(rec.usage.completionTokens).toBe(Math.ceil("partial text from upstream".length / 4));
    expect(adapter.lastSignal!.aborted).toBe(true);

    // The reservation must be fully reconciled to the partial usage: nothing leaked.
    expect(acct.tokens).toBe(rec.usage.totalTokens);
    expect(acct.spend).toBeCloseTo(computeCostUsd("groq", "llama-3.1-8b-instant", rec.usage), 12);
    expect(rec.costUsd).toBeCloseTo(acct.spend, 12);
  });

  it("upstream dies mid-stream: charges partial usage (not 0, not the full reservation) and records an error with partial_output", async () => {
    const acct = new FakeAccounting();
    const adapter = new FakeAdapter("groq", "llama-3.1-8b-instant", async function* () {
      yield { delta: "abcdefgh" };
      throw new Error("connection reset");
    });
    const port = await start([adapter], acct);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const text = await res.text();
    expect(text).toContain("stream interrupted");

    expect(acct.records).toHaveLength(1);
    const rec = acct.records[0]!;
    expect(rec.status).toBe("error");
    expect(rec.partialOutput).toBe(true);
    expect(rec.usage.completionTokens).toBe(2);
    expect(acct.tokens).toBe(rec.usage.totalTokens);
    expect(acct.spend).toBeCloseTo(rec.costUsd, 12);
  });

  it("completed stream without provider usage is recorded with estimated usage, not zero", async () => {
    const acct = new FakeAccounting();
    const adapter = new FakeAdapter("groq", "llama-3.1-8b-instant", async function* () {
      yield { delta: "a complete answer" };
    });
    const port = await start([adapter], acct);
    await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body })).text();

    const rec = acct.records[0]!;
    expect(rec.status).toBe("success");
    expect(rec.usageEstimated).toBe(true);
    expect(rec.usage.totalTokens).toBeGreaterThan(0);
    expect(acct.tokens).toBe(rec.usage.totalTokens);
  });

  it("stream idle timeout settles the reservation too", async () => {
    const acct = new FakeAccounting();
    const adapter = new FakeAdapter("groq", "llama-3.1-8b-instant", async function* () {
      yield { delta: "xxxx" };
      await new Promise<never>(() => {});
    });
    const port = await start([adapter], acct, 60);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body });
    await res.text();
    expect(acct.records[0]!.status).toBe("error");
    expect(acct.records[0]!.partialOutput).toBe(true);
    expect(acct.tokens).toBe(acct.records[0]!.usage.totalTokens);
  });

  it("non-stream: all providers failing releases the whole reservation", async () => {
    const acct = new FakeAccounting();
    const adapter = new FakeAdapter("groq", "llama-3.1-8b-instant");
    adapter.chat = async () => {
      throw new TypeError("boom");
    };
    const port = await start([adapter], acct);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], maxTokens: 10 }),
    });
    expect(res.status).toBe(502);
    expect(acct.tokens).toBe(0);
    expect(acct.spend).toBeCloseTo(0, 12);
  });
});

describe("preflight ordering and fail-closed pricing", () => {
  it("rejects an unpriced model with 422 before consuming any rate-limit or budget quota", async () => {
    const acct = new FakeAccounting();
    const port = await start([new FakeAdapter("groq", "llama-3.1-8b-instant")], acct);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "totally-unpriced-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(422);
    expect(acct.requests).toBe(0);
    expect(acct.tokens).toBe(0);
    expect(acct.spend).toBe(0);
  });

  it("budget rejection hands back the request slot and the token reservation", async () => {
    const acct = new FakeAccounting();
    acct.budgetCap = 0; // anything non-free is over the cap
    const port = await start([new FakeAdapter("groq", "llama-3.1-8b-instant")], acct);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    });
    expect(res.status).toBe(402);
    expect(acct.requests).toBe(0);
    expect(acct.tokens).toBe(0);
  });

  it("token-limit rejection hands back the request slot", async () => {
    const acct = new FakeAccounting();
    acct.tokenLimit = 1;
    const port = await start([new FakeAdapter("groq", "llama-3.1-8b-instant")], acct);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    });
    expect(res.status).toBe(429);
    expect(acct.requests).toBe(0);
    expect(acct.spend).toBe(0);
  });

  it("reserves the worst-case price across the fallback chain, input and output", async () => {
    const acct = new FakeAccounting();
    const port = await start(
      [new FakeAdapter("groq", "llama-3.1-8b-instant"), new FakeAdapter("gemini", "gemini-flash-lite-latest")],
      acct,
    );
    let reserved = 0;
    const original = acct.budgetEnforcer.reserve;
    acct.budgetEnforcer.reserve = async (id: string, est: number) => {
      reserved = est;
      return original(id, est);
    };
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(400) }], maxTokens: 1000 }),
    });
    // gemini-flash-lite-latest is the pricier of the two: 100 prompt tokens in @0.3/M + 1000 out @2.5/M
    const expected = (100 / 1e6) * 0.3 + (1000 / 1e6) * 2.5;
    expect(reserved).toBeCloseTo(expected, 12);
  });
});
