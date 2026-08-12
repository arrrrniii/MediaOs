-- ═══════════════════════════════════════════════════════════
--  Cold Storage Backends + Archive/Restore (Phase 6)
--
--  storage_backends already exists (migration 006). It holds the whole
--  connection config for a remote backend in a single encrypted JSON blob
--  (configuration_encrypted) rather than a column per field, so no secret
--  ever lands in a plaintext column. This migration only adds the two bits
--  of operational metadata the archiver needs:
--
--    - last_verified_at  when the backend last passed a connectivity probe
--                        (the "verify" button on the settings page).
--    - is_cold_default   the backend new archives go to. At most one per
--                        scope (per account, plus one system-wide default),
--                        mirroring the is_default uniqueness rule.
--
--  file_objects already carries storage_tier / status / archived_at from 006,
--  so nothing is added to it beyond a composite (status, storage_tier) index
--  the archive/restore/reconcile sweeps filter on.
--
--  Idempotent + re-runnable.
-- ═══════════════════════════════════════════════════════════

-- ── storage_backends: operational metadata ──────────────
ALTER TABLE storage_backends ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
ALTER TABLE storage_backends ADD COLUMN IF NOT EXISTS is_cold_default  BOOLEAN NOT NULL DEFAULT FALSE;

-- At most one cold-default backend per scope. System-wide rows (account_id
-- NULL) collapse to the all-zeros sentinel so they share one uniqueness
-- bucket, exactly like idx_storage_backends_one_default.
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_backends_one_cold_default
    ON storage_backends ((COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    WHERE is_cold_default;

-- ── file_objects: archive/restore sweep index ───────────
-- The archive/restore/reconcile passes filter objects by (status, tier)
-- together (e.g. "available AND cold"), so a composite index serves them
-- better than the two single-column indexes 006 created.
CREATE INDEX IF NOT EXISTS idx_file_objects_status_tier
    ON file_objects(status, storage_tier);

-- ── Seed note ───────────────────────────────────────────
-- The system-default MinIO backend (hot) is seeded by migration 006 and is
-- left untouched. A cold backend requires real off-site credentials, so it is
-- NOT seeded here — an operator adds one from the Storage Backends settings
-- page (which encrypts the config into configuration_encrypted and marks it
-- is_cold_default). Until then archive jobs no-op with a clear "no cold
-- backend configured" outcome rather than moving bytes nowhere.
