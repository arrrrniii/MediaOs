-- ═══════════════════════════════════════════════════════════
--  Durable Processing: Transactional Outbox + Job Ledger (Phase 4)
--
--  BullMQ (Redis) now owns the live state of every background job, but
--  Redis is not the source of truth for "did this event happen". Two DB
--  structures bridge that gap:
--
--    outbox_events  — events written IN THE SAME TRANSACTION as the state
--                     change that produced them (a file finishing upload,
--                     a delete). A poller drains them into durable BullMQ
--                     jobs. Because the event and the state change commit
--                     together, an event can never be lost on a crash and
--                     a webhook can never fire for a change that rolled back.
--
--    job_attempts   — a DB-visible mirror of BullMQ job lifecycle so the
--                     dashboard can list and retry failed jobs without
--                     reaching into Redis. BullMQ's failed set + the 'dead'
--                     status here together form the dead-letter surface.
-- ═══════════════════════════════════════════════════════════

-- ── Outbox events ───────────────────────────────────────
-- An event awaiting durable dispatch. Inserted transactionally with the
-- row it describes; the outbox poller enqueues the real job and flips
-- status to 'delivered'. 'failed' means the poller gave up enqueuing it.
CREATE TABLE outbox_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type  VARCHAR(40),                              -- e.g. 'file'
    aggregate_id    UUID,
    event_type      VARCHAR(60) NOT NULL,                     -- e.g. 'file.uploaded'
    payload         JSONB NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts        INT NOT NULL DEFAULT 0,
    available_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    delivered_at    TIMESTAMPTZ,
    last_error      TEXT
);

-- The poller's hot query: pending rows that are due, oldest first. Partial
-- so the index stays small once rows are delivered.
CREATE INDEX idx_outbox_pending_due ON outbox_events (available_at)
    WHERE status = 'pending';

CREATE INDEX idx_outbox_aggregate ON outbox_events (aggregate_type, aggregate_id);

-- ── Job attempts (DB-visible job ledger) ────────────────
-- One row per (queue, job_id) tracking the latest known lifecycle state of
-- a BullMQ job. Written 'active' when enqueued, advanced by worker events.
-- 'dead' marks a job that exhausted its attempts — the dashboard's failed
-- list and retry surface read from here.
CREATE TABLE job_attempts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue        VARCHAR(40) NOT NULL,
    job_id       VARCHAR(120) NOT NULL,
    file_id      UUID,
    status       VARCHAR(20) NOT NULL
                     CHECK (status IN ('active', 'completed', 'failed', 'stalled', 'dead')),
    attempt      INT NOT NULL DEFAULT 1,
    error        TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    finished_at  TIMESTAMPTZ
);

-- One live ledger row per BullMQ job; updates target it by (queue, job_id).
CREATE UNIQUE INDEX idx_job_attempts_queue_job ON job_attempts (queue, job_id);
CREATE INDEX idx_job_attempts_file ON job_attempts (file_id);
CREATE INDEX idx_job_attempts_status ON job_attempts (status);
