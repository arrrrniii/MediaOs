-- ═══════════════════════════════════════════════════════════
--  Intelligent Lifecycle Management (Phase 5)
--
--  Adds the durable surfaces the lifecycle scanner and inbox need:
--    - lifecycle_audit         an immutable, append-only trail of every
--                              lifecycle decision (scan, protect, archive,
--                              delete, restore, …). Never UPDATEd or DELETEd.
--    - lifecycle_notifications  per-account review notifications the scanner
--                              raises when it finds new cold candidates.
--    - access_daily            per-file, per-day access counters — the durable
--                              form of the Redis access aggregation. Distinct
--                              from the project-level usage_daily table because
--                              the scanner and inbox need per-asset access.
--    - lifecycle_kv            a tiny key/value scratch table used by the
--                              access-log importer to remember its byte offset
--                              so re-runs are incremental and idempotent.
--
--  The files table already carries every lifecycle column (lifecycle_state,
--  last_accessed_at, access_count, retention_until, protected_from_delete)
--  from migration 006, so nothing is added to it here beyond a scan-support
--  index. Idempotent + re-runnable.
-- ═══════════════════════════════════════════════════════════

-- ── Lifecycle audit (append-only) ───────────────────────
-- One row per lifecycle decision. Application code only ever INSERTs; there is
-- no UPDATE/DELETE path, so this is the tamper-evident history of what the
-- scanner and operators did to each file.
CREATE TABLE IF NOT EXISTS lifecycle_audit (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID,
    project_id  UUID,
    file_id     UUID,
    action      VARCHAR(40) NOT NULL,      -- e.g. scan.cold_candidate, action.protect, action.archive_all, action.mark_delete, action.delete, action.keep, action.restore, state.change
    from_state  VARCHAR(20),
    to_state    VARCHAR(20),
    actor       VARCHAR(120),              -- user id, or 'system:scanner'
    detail      JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_audit_file ON lifecycle_audit(file_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_audit_project ON lifecycle_audit(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_audit_account ON lifecycle_audit(account_id, created_at DESC);

-- ── Lifecycle notifications ─────────────────────────────
-- Account-scoped review prompts. The scanner raises one per project per run
-- that turned up new cold candidates; the dashboard surfaces the unread count.
CREATE TABLE IF NOT EXISTS lifecycle_notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL,
    project_id  UUID,
    type        VARCHAR(40) NOT NULL DEFAULT 'lifecycle_review',
    title       TEXT,
    body        TEXT,
    data        JSONB NOT NULL DEFAULT '{}',
    status      VARCHAR(20) NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'dismissed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_notifications_account
    ON lifecycle_notifications(account_id, status, created_at DESC);

-- ── Per-file per-day access counters ────────────────────
-- The durable form of the Redis access aggregation. A row per (file, day)
-- holds the day's download/transform/video-play counts; the flush and the
-- access-log importer both UPSERT-add into it. Separate from usage_daily,
-- which is project-level and billing-oriented — this is per-asset so the
-- scanner and inbox can show real per-file access history.
CREATE TABLE IF NOT EXISTS access_daily (
    id           BIGSERIAL PRIMARY KEY,
    file_id      UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    day          DATE NOT NULL,
    downloads    BIGINT NOT NULL DEFAULT 0,
    transforms   BIGINT NOT NULL DEFAULT 0,
    video_plays  BIGINT NOT NULL DEFAULT 0,
    UNIQUE (file_id, day)
);

CREATE INDEX IF NOT EXISTS idx_access_daily_file ON access_daily(file_id);

-- ── Lifecycle key/value scratch ─────────────────────────
-- Small durable scratch space. Used by the access-log importer to remember the
-- last byte offset it read from each nginx access log, so re-runs pick up where
-- they left off (incremental + idempotent).
CREATE TABLE IF NOT EXISTS lifecycle_kv (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Scanner support index ───────────────────────────────
-- The daily scanner sweeps active, non-deleted files ordered/filtered by last
-- access within a project. This keeps that query sane. The tuned partial scan
-- index is Phase 9's job, deliberately not added here.
CREATE INDEX IF NOT EXISTS idx_files_project_last_accessed
    ON files(project_id, last_accessed_at)
    WHERE deleted_at IS NULL;
