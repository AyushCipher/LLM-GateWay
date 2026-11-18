-- Migration 001: cache tenant isolation, API key lifecycle, partial-stream accounting.
-- Idempotent: safe to re-run. Applied automatically by `npm run migrate` after schema.sql.

-- 1. semantic_cache: tenant + sampling params ------------------------------------------------
ALTER TABLE semantic_cache ADD COLUMN IF NOT EXISTS api_key_id UUID;
ALTER TABLE semantic_cache ADD COLUMN IF NOT EXISTS temperature REAL;
ALTER TABLE semantic_cache ADD COLUMN IF NOT EXISTS max_tokens INTEGER;

-- Legacy rows have no owner and were written under a model name shared across providers. They cannot be
-- served safely to any tenant, and it is only a cache, so drop them.
DELETE FROM semantic_cache WHERE api_key_id IS NULL OR temperature IS NULL OR max_tokens IS NULL;

ALTER TABLE semantic_cache ALTER COLUMN api_key_id SET NOT NULL;
ALTER TABLE semantic_cache ALTER COLUMN temperature SET NOT NULL;
ALTER TABLE semantic_cache ALTER COLUMN max_tokens SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_semantic_cache_tenant_lookup
    ON semantic_cache (api_key_id, model, temperature, max_tokens);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_expires_at ON semantic_cache (expires_at);

-- 2. api_keys: revocation, expiry, last use -------------------------------------------------
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- 3. requests: partial streams ----------------------------------------------------------------
ALTER TABLE requests ADD COLUMN IF NOT EXISTS partial_output BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS usage_estimated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check
    CHECK (status IN ('success', 'error', 'budget_rejected', 'rate_limited', 'aborted'));
