-- ═══════════════════════════════════════════════════════════
--  Self-Healing Control Plane (Phase 7)
--
--  Adds the durable surfaces the reconciler and health dashboard need:
--    - health_snapshots      periodic point-in-time counts of system health
--                            (healthy assets, missing/orphan/corrupt objects,
--                            stuck jobs, failed webhooks, …). The cleanup job
--                            prunes all but the most recent N.
--    - reconciliation_runs   one row per reconciler pass: what kind, when it
--                            ran, how much it checked, how many issues it found
--                            and repaired. The operator-facing history.
--    - reconciliation_issues one row per problem a run found (and whether it
--                            was auto-repaired). The detail behind a run.
--
--  Cursors for bounded/incremental scans (e.g. the orphan-object list cursor)
--  reuse the existing lifecycle_kv table from migration 008 rather than adding
--  a second key/value table. Every repair the reconciler makes is ALSO written
--  to lifecycle_audit (migration 008) with actor 'system:reconciler', so the
--  immutable audit log is the tamper-evident record of automatic repairs.
--
--  Idempotent + re-runnable.
-- ═══════════════════════════════════════════════════════════

-- ── Health snapshots ────────────────────────────────────
-- A periodic snapshot of the health-dashboard numbers. computeHealth() writes
-- one every few minutes; the cleanup job keeps only the latest N. `metrics` is
-- an open JSONB bag so new health numbers can be added without a migration.
CREATE TABLE IF NOT EXISTS health_snapshots (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    captured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metrics      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_snapshots_captured ON health_snapshots(captured_at DESC);

-- ── Reconciliation runs ─────────────────────────────────
-- One row per reconciler pass. 'running' while in flight, then 'completed' or
-- 'failed'. checked/issues_found/repaired are the run's roll-up counters;
-- `details` carries the per-category breakdown.
CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          VARCHAR(40) NOT NULL,               -- 'all' | a single category | 'category'
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    checked       INT NOT NULL DEFAULT 0,
    issues_found  INT NOT NULL DEFAULT 0,
    repaired      INT NOT NULL DEFAULT 0,
    details       JSONB NOT NULL DEFAULT '{}',
    status        VARCHAR(20) NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_kind ON reconciliation_runs(kind, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_started ON reconciliation_runs(started_at DESC);

-- ── Reconciliation issues ───────────────────────────────
-- One row per problem a run detected. `repaired` records whether the reconciler
-- fixed it automatically and `repair_action` names how; an unrepaired 'error'
-- row is what an operator must look at.
CREATE TABLE IF NOT EXISTS reconciliation_issues (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id        UUID REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
    category      VARCHAR(40) NOT NULL,               -- one of the reconcile categories
    severity      VARCHAR(10) NOT NULL DEFAULT 'warn'
                      CHECK (severity IN ('info', 'warn', 'error')),
    file_id       UUID,
    object_id     UUID,
    backend_id    UUID,
    description   TEXT,
    repaired      BOOLEAN NOT NULL DEFAULT FALSE,
    repair_action VARCHAR(60),
    detail        JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_issues_run ON reconciliation_issues(run_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_issues_category ON reconciliation_issues(category);
CREATE INDEX IF NOT EXISTS idx_reconciliation_issues_file ON reconciliation_issues(file_id);
