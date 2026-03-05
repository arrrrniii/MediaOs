-- ═══════════════════════════════════════════════════════════
--  Webhooks
-- ═══════════════════════════════════════════════════════════

CREATE TABLE webhooks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    url             VARCHAR(2000) NOT NULL,
    secret          VARCHAR(64) NOT NULL,                  -- for HMAC-SHA256 signing
    events          TEXT[] NOT NULL DEFAULT '{file.uploaded,file.processed,file.failed,file.deleted}',
    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active, paused, disabled
    -- Delivery stats
    last_triggered  TIMESTAMPTZ,
    last_status     INTEGER,                               -- HTTP status of last delivery
    success_count   INTEGER NOT NULL DEFAULT 0,
    failure_count   INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhooks_project_id ON webhooks(project_id);
CREATE INDEX idx_webhooks_status ON webhooks(status);

-- Webhook delivery log — for debugging and retry
CREATE TABLE webhook_deliveries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id      UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event           VARCHAR(50) NOT NULL,
    payload         JSONB NOT NULL,
    -- Delivery attempt info
    attempt         INTEGER NOT NULL DEFAULT 1,
    status_code     INTEGER,
    response_body   TEXT,
    response_ms     INTEGER,
    error           TEXT,
    -- Status
    delivered       BOOLEAN NOT NULL DEFAULT FALSE,
    next_retry_at   TIMESTAMPTZ,                           -- null if delivered or max retries reached
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at)
    WHERE delivered = FALSE AND next_retry_at IS NOT NULL;

CREATE TRIGGER trg_webhooks_updated_at BEFORE UPDATE ON webhooks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
