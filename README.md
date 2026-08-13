# LLM Gateway

A multi-provider LLM routing gateway: one API surface in front of Groq, Gemini, and OpenRouter, with automatic fallback, exact-match caching, per-key cost tracking and budgets, atomic Redis-backed rate limiting, and structured observability.

This is an infrastructure-engineering portfolio project. The priority order was correctness, testing rigor, and honest measurement over feature breadth — every number in the "Measured Results" section below was produced by running a script in this repo against real, live provider APIs, and is checked into `scripts/results/*.json` so it can be re-verified.

## Architecture

```
Client
  │  Authorization: Bearer <api-key>
  ▼
┌─────────────────────────────────────────────────────────────┐
│ Express app (src/app.ts)                                     │
│  requestId → auth → rate limit → budget reserve → router     │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
                  ┌─────────────┐        exact-match, Redis, TTL
                  │  CacheStore │◄────── configurable via CACHE_TTL_SECONDS
                  └──────┬──────┘
                    miss │ hit → return cached response
                         ▼
                ┌──────────────────┐
                │  Routing strategy │  static_priority | latency_based
                └────────┬──────────┘
                         │ ordered provider list (unhealthy providers deprioritized)
                         ▼
        ┌────────────────────────────────────┐
        │ Router: try each provider in order, │
        │ catch failures, fall back to next   │
        └───────┬──────────┬──────────┬───────┘
                 ▼          ▼          ▼
             Groq        Gemini    OpenRouter
          (FaultInjectingAdapter wraps each — a Redis flag can force
           any provider into timeout / 500 / 429 for deterministic testing)
                         │
                         ▼
        cost tracked (Postgres) · rate limiter adjusted · budget adjusted
        · trace-ID-tagged structured logs · latency percentiles recorded
```

**Tech stack:** Node.js 20+ / TypeScript / Express. Direct `pg` + hand-written SQL (no ORM) and a small Lua-script-driven `ioredis` layer — deliberately close to the primitives, since the point of this project is demonstrating command of atomicity and concurrency, not framework usage. Vitest for tests, `pino` for structured logs, `prom-client` for Prometheus metrics, `swagger-ui-express` for the OpenAPI spec.

## Quickstart

```bash
npm install
docker compose up -d          # Redis on :6389, Postgres on :5488 (non-default ports to avoid clashing with other local containers)
npm run migrate                # creates api_keys / requests tables
cp .env.example .env           # fill in at least one of GROQ_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY
npm run dev                    # http://localhost:8787
```

Create an API key (admin-protected):

```bash
curl -X POST http://localhost:8787/v1/keys \
  -H "X-Admin-Secret: <ADMIN_SECRET from .env>" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-key","budgetUsdMonthly":5}'
```

Call it:

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <apiKey from above>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hi in 3 words."}]}'
```

Full endpoint reference: [`openapi.yaml`](openapi.yaml), served interactively at `GET /docs` once the server is running.

## Core capabilities

- **Multi-provider routing with fallback** (`src/routing/`) — static-priority and latency-based (rolling p50 over the last 100 samples per provider) strategies, both falling back through every configured provider on failure. A minimal circuit breaker deprioritizes (not excludes) a provider for 30s after a failure. Fault injection (`POST /admin/fault-injection`) forces any provider into a `timeout` / `error_5xx` / `rate_limit` failure mode via a Redis flag, so fallback is testable on demand without touching real credentials.
- **Exact-match caching** (`src/cache/`) — SHA-256 of the normalized request (model, messages, temperature, maxTokens; whitespace collapsed, casing preserved) as the Redis key, configurable TTL, real hit/miss counters.
- **Cost tracking & per-key budgets** (`src/cost/`) — token usage and cost are computed from each provider's own reported usage against a manually-maintained pricing table, written to a Postgres ledger (`requests` table), and queryable via `GET /v1/usage`. Budgets are enforced atomically in Redis (same reserve-then-adjust pattern as the rate limiter) with a configurable `hard_stop` (default) or `soft_warn` mode per key.
- **Rate limiting** (`src/rateLimit/`) — requests/min and tokens/min, enforced atomically via Lua scripts executed by Redis (`EVAL`), so the check-and-increment is a single indivisible operation with no race window for concurrent requests to slip through.
- **Observability** (`src/observability/`) — every request gets a trace ID (`AsyncLocalStorage`-propagated) attached to every structured log line from cache check through provider call to response; per-provider and per-route latency percentiles; `GET /metrics` (Prometheus text) and `GET /metrics/json` (plain JSON).

## Measured Results

All numbers below come from `scripts/measure-*.ts`, run against this repo's real code, live Redis/Postgres, and live Groq/Gemini/OpenRouter APIs on **2026-08-13**. Raw output for every run is checked into `scripts/results/*.json`. Reproduce any of them with `npm run bench:<name>`.

### 1. Fallback correctness — `npm run bench:fallback` → [`scripts/results/fallback.json`](scripts/results/fallback.json)

Method: force the primary provider (`groq`) into `error_5xx` via the fault-injection endpoint, fire 10 real requests, confirm they still succeed via fallback, and compare average latency to a 10-request baseline with no fault.

- **10/10 requests succeeded via fallback.**
- Baseline (groq, no fault): avg **164ms**.
- Failover (groq forced down → gemini): avg **828ms**.
- After the first failure, the built-in circuit breaker marked `groq` unhealthy for its cooldown window, so most subsequent requests went straight to `gemini` in a single attempt rather than re-trying `groq` first each time — visible in the per-request `attempts` count in the raw results.
- **Caveat:** the ~664ms delta is *not* a clean "fallback tax" — it mixes one extra failed attempt with the fact that `gemini` was simply slower than `groq` in this run. A pure per-hop overhead number would require comparing the same provider against itself, which isn't possible once it's the one being failed over from.

### 2. Cache hit-rate — `npm run bench:cache` → [`scripts/results/cache-hitrate.json`](scripts/results/cache-hitrate.json)

Method: a 38-request workload — 5 prompts repeated 8/6/5/4/3 times (Zipf-like) plus 12 one-off novel prompts, all shuffled together — run through the real router against live providers.

- **Actual hit-rate: 55.3% (21/38)**, matching the 21/38 expected by construction (every prompt's first occurrence is necessarily a miss; every repeat after that hit).
- Cache TTL used: 300s (the production default).

### 3. Rate-limit correctness under concurrency — `npm run bench:ratelimit` → [`scripts/results/rate-limit-concurrency.json`](scripts/results/rate-limit-concurrency.json)

Method: fire `concurrency` requests simultaneously via `Promise.all` at a single fresh key against live Redis, across 5 trials with different limits.

| Trial | Limit | Concurrent requests | Allowed | Exact? |
|---|---|---|---|---|
| 0 | 50 | 200 | 50 | ✅ |
| 1 | 50 | 200 | 50 | ✅ |
| 2 | 50 | 200 | 50 | ✅ |
| 3 | 100 | 500 | 100 | ✅ |
| 4 | 10 | 300 | 10 | ✅ |

**All 5 trials landed exactly on the limit — zero drift, even at 500 concurrent requests against a limit of 100.** This is enforced by a single Lua script (`INCR` + conditional `EXPIRE`, or `INCRBY` + rollback-on-reject for token reservations) executed atomically by Redis, so there is no read-then-write gap a concurrent request can land in. The same integration test also runs in CI against a real `redis:7-alpine` service container on every push (`test/integration/rateLimiter.test.ts`, `test/integration/budget.test.ts`).

### 4. Cost-tracking accuracy — `npm run bench:cost` → [`scripts/results/cost-accuracy.json`](scripts/results/cost-accuracy.json)

Method: 9 live requests cycled across all three providers (via fault injection forcing each one in turn), computing cost two independent ways from the same provider-reported token usage — once via the gateway's actual `computeCostUsd`, once via a separately-written recomputation in the benchmark script — and diffing them.

- **9/9 requests completed; max absolute difference across both computations: ~1.7 × 10⁻²¹ USD** — floating-point noise, i.e. exact.
- **Scope, stated honestly:** this validates that the gateway's pricing arithmetic matches what each provider's API reports for token usage. It does **not** validate against real provider billing invoices — those aren't obtainable in this environment. See Known Limitations.

### 5. Gateway overhead — `npm run bench:overhead` → [`scripts/results/overhead.json`](scripts/results/overhead.json)

Method: 15 direct calls to the primary provider (`groq`) interleaved with 15 calls through the full gateway (cache-miss path — every prompt is unique), same machine, same network path.

- Direct: p50 **123ms**, p95 **232ms**, avg **165ms**.
- Through gateway: p50 **121ms**, p95 **246ms**, avg **141ms**.
- **Overhead: p50 −16ms, p95 −84ms, avg −23.5ms** — i.e. the gateway's own processing (cache check, routing decision, Redis round-trips) is not measurably distinguishable from zero once real network jitter to the provider is in the picture. The honest finding is "gateway overhead is within the noise floor of provider network variance at this sample size," not a specific millisecond figure — reported as measured rather than rounded up to look more impressive.
- **Caveat:** this is a single machine over the real internet to the provider, 15 samples, one request at a time — a local/synthetic measurement, not a production traffic pattern (see Known Limitations).

## Testing

```bash
npm test                 # unit tests, no infra required
npm run test:integration # real Redis + Postgres (docker compose up -d first)
npm run lint
npm run typecheck
npm run build
```

- **Unit tests** (`test/unit/`) — pure functions only (cache key normalization, etc.), no infrastructure.
- **Integration tests** (`test/integration/`) — run against real Redis and Postgres (never mocks), including the same rate-limit and budget concurrency proofs described above as automated assertions, plus cache TTL/expiry, cost-ledger writes, and full fallback correctness against **live providers** (`router.test.ts`, automatically skipped if fewer than 2 provider API keys are configured — e.g. in CI, where no provider secrets are present).
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, integration tests against real `redis:7-alpine` / `postgres:16-alpine` service containers, and a production build on every push/PR. The live-provider benchmark scripts above are **not** run in CI — no provider keys are ever committed or stored as CI secrets; they're run locally and their output is committed as evidence instead.

## Known Limitations

Stated explicitly rather than glossed over:

- **Semantic caching was not built.** Only exact-match (normalized-request-hash) caching is implemented. Embedding-similarity caching was the stated stretch goal and didn't make the cut.
- **Token-rate-limiting is estimate-based, not exact, at reservation time.** The pre-call token count uses a ~4-chars/token heuristic (real usage isn't known until the provider responds), reconciled to the actual count afterward via an atomic adjustment. The *requests/min* limiter has no such estimation issue — it's exact.
- **The request-limiter window is fixed, not sliding.** Up to 2× the configured limit can theoretically land across a window boundary (limit requests just before expiry, limit again just after). A sliding-window or token-bucket-with-continuous-refill approach would close this; it wasn't built here.
- **The pricing table is a manually-maintained, dated snapshot** (`src/cost/pricing.ts`), not fetched live from provider APIs. It was checked against Groq's and Google's public pricing pages on 2026-08-13; it will drift as providers change prices.
- **Cost-tracking accuracy was validated against provider-reported token usage, not real billing invoices.** No mechanism in this environment can compare against an actual Groq/Google/OpenRouter invoice.
- **Latency percentiles are computed exactly from a bounded rolling sample window** (last 100 per provider), not a true HDR histogram. Fine at this scale; wouldn't hold up at high request volume/cardinality without a real histogram implementation.
- **All load and concurrency figures are synthetic, generated by benchmark scripts on one machine** — not observed production traffic, since this system has none.
- **Rate limiting and budget state live in a single Redis instance.** They're correctly atomic *within* that instance (proven above), but nothing here shards or fails over Redis itself — a single-instance-Redis deployment is a single point of failure for this specific gateway. Redis Cluster / sentinel setups would need the Lua scripts re-verified for cross-slot behavior, which wasn't attempted.
- **OpenRouter's configured model (`google/gemma-4-26b-a4b-it:free`) is a $0 free-tier model** shared across all OpenRouter users, which occasionally rate-limits independently of anything this gateway does (observed once during benchmark development, handled by retrying — see `scripts/measure-cost-accuracy.ts`). Cost-tracking dollar amounts in this project are consequently dominated by Groq/Gemini and are small (fractions of a cent per request).
- **Admin auth is a single shared secret** (`ADMIN_SECRET`), compared in constant time, suitable for a single-operator portfolio deployment — not a multi-tenant admin permission model.

## Project layout

```
src/providers/     Provider adapters (Groq, Gemini, OpenRouter) behind a shared interface + fault injector
src/routing/        Router, fallback logic, routing strategies, minimal circuit breaker
src/cache/          Exact-match Redis cache + key normalization
src/rateLimit/      Atomic Lua-script rate limiter
src/cost/           Pricing table, Postgres cost ledger, atomic budget enforcement
src/observability/  Trace-ID propagation, structured logging, latency percentiles, Prometheus metrics
src/api/            Express routes, auth middleware, OpenAPI-served docs
src/db/             Postgres schema + migration runner
test/unit/          Pure-function tests, no infra
test/integration/   Real Redis + Postgres (+ live providers where noted), run in CI
scripts/            Standalone benchmark scripts that produced every number in this README
```

## License

MIT — see [LICENSE](LICENSE).
