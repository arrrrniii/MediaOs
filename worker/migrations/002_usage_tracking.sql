-- ═══════════════════════════════════════════════════════════
--  Usage Tracking
-- ═══════════════════════════════════════════════════════════

-- Daily usage aggregation per project
CREATE TABLE usage_daily (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    date            DATE NOT NULL,
    -- Counters
    uploads         INTEGER NOT NULL DEFAULT 0,
    upload_bytes    BIGINT NOT NULL DEFAULT 0,             -- total bytes uploaded (original)
    downloads       INTEGER NOT NULL DEFAULT 0,
    download_bytes  BIGINT NOT NULL DEFAULT 0,             -- total bytes served
    transforms      INTEGER NOT NULL DEFAULT 0,            -- imgproxy resize requests
    deletes         INTEGER NOT NULL DEFAULT 0,
    api_requests    INTEGER NOT NULL DEFAULT 0,            -- total API calls
    -- Snapshot
    storage_bytes   BIGINT NOT NULL DEFAULT 0,             -- storage snapshot at end of day
    file_count      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_usage_daily_project_date ON usage_daily(project_id, date);
CREATE INDEX idx_usage_daily_date ON usage_daily(date);

-- Bandwidth log — individual serve events for accurate bandwidth tracking
-- This table is append-only, partitioned by month in production
CREATE TABLE bandwidth_log (
    id              BIGSERIAL PRIMARY KEY,
    project_id      UUID NOT NULL,
    file_id         UUID,
    bytes_served    BIGINT NOT NULL,
    is_transform    BOOLEAN NOT NULL DEFAULT FALSE,        -- was this an imgproxy resize?
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bandwidth_log_project_created ON bandwidth_log(project_id, created_at);

-- Plan limits reference table
CREATE TABLE plans (
    id              VARCHAR(50) PRIMARY KEY,               -- free, pro, business, enterprise
    name            VARCHAR(100) NOT NULL,
    max_projects    INTEGER NOT NULL DEFAULT 1,
    max_storage     BIGINT NOT NULL DEFAULT 1073741824,    -- bytes (default 1GB)
    max_bandwidth   BIGINT NOT NULL DEFAULT 5368709120,    -- bytes/month (default 5GB)
    max_file_size   INTEGER NOT NULL DEFAULT 10485760,     -- bytes per file (default 10MB)
    rate_limit      INTEGER NOT NULL DEFAULT 100,          -- requests/min per key
    max_keys        INTEGER NOT NULL DEFAULT 2,            -- API keys per project
    features        JSONB DEFAULT '{}',                    -- webhooks, signed_urls, bulk_upload, etc.
    price_monthly   INTEGER NOT NULL DEFAULT 0,            -- cents
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default plans
INSERT INTO plans (id, name, max_projects, max_storage, max_bandwidth, max_file_size, rate_limit, max_keys, features, price_monthly) VALUES
    ('free',       'Free',       1,   1073741824,    5368709120,    10485760,   60,   2,   '{"webhooks": false, "signed_urls": false, "bulk_upload": false}', 0),
    ('pro',        'Pro',        5,   53687091200,   107374182400,  104857600,  200,  10,  '{"webhooks": true, "signed_urls": true, "bulk_upload": true}',    1900),
    ('business',   'Business',   -1,  268435456000,  536870912000,  524288000,  500,  50,  '{"webhooks": true, "signed_urls": true, "bulk_upload": true}',    4900),
    ('enterprise', 'Enterprise', -1,  -1,            -1,            -1,         -1,   -1,  '{"webhooks": true, "signed_urls": true, "bulk_upload": true}',    0);
-- Note: -1 means unlimited
