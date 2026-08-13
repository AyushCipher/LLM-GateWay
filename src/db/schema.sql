CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    name TEXT NOT NULL,
    budget_usd_monthly NUMERIC(12, 4) NOT NULL,
    budget_mode TEXT NOT NULL DEFAULT 'hard_stop' CHECK (budget_mode IN ('hard_stop', 'soft_warn')),
    requests_per_minute INTEGER NOT NULL,
    tokens_per_minute INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id TEXT NOT NULL,
    api_key_id UUID NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
    provider TEXT,
    model TEXT,
    routing_strategy TEXT NOT NULL,
    attempted_providers TEXT[] NOT NULL DEFAULT '{}',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(14, 8) NOT NULL DEFAULT 0,
    cache_hit BOOLEAN NOT NULL DEFAULT false,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('success', 'error', 'budget_rejected', 'rate_limited')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_requests_api_key_created_at ON requests (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests (provider);
CREATE INDEX IF NOT EXISTS idx_requests_trace_id ON requests (trace_id);
