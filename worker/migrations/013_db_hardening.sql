-- ═══════════════════════════════════════════════════════════
--  Phase 9 — Database hardening
--  CHECK constraints, non-negative guards, FK indexes, partial
--  and lifecycle-scan indexes, unique storage keys per backend.
--  Every statement is idempotent so re-running is safe.
-- ═══════════════════════════════════════════════════════════

-- ── Helper: add a CHECK constraint only if absent ───────────
-- ADD CONSTRAINT has no IF NOT EXISTS, so guard on pg_constraint.
DO $$
BEGIN
  -- files.status
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_status_check') THEN
    ALTER TABLE files ADD CONSTRAINT files_status_check
      CHECK (status IN ('uploading', 'processing', 'done', 'failed'));
  END IF;
  -- files.access
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_access_check') THEN
    ALTER TABLE files ADD CONSTRAINT files_access_check
      CHECK (access IN ('public', 'private', 'signed'));
  END IF;
  -- files non-negative sizes
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_size_nonneg') THEN
    ALTER TABLE files ADD CONSTRAINT files_size_nonneg CHECK (size >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_original_size_nonneg') THEN
    ALTER TABLE files ADD CONSTRAINT files_original_size_nonneg
      CHECK (original_size IS NULL OR original_size >= 0);
  END IF;

  -- projects counters non-negative
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_storage_used_nonneg') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_storage_used_nonneg CHECK (storage_used >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_file_count_nonneg') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_file_count_nonneg CHECK (file_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_status_check') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_status_check
      CHECK (status IN ('active', 'paused', 'deleted'));
  END IF;

  -- api_keys rate_limit non-negative + status
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_rate_limit_nonneg') THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_rate_limit_nonneg
      CHECK (rate_limit IS NULL OR rate_limit >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_status_check') THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_status_check
      CHECK (status IN ('active', 'revoked'));
  END IF;

  -- accounts.status
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_status_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_status_check
      CHECK (status IN ('active', 'suspended', 'deleted'));
  END IF;
END $$;

-- ── Missing foreign-key indexes ─────────────────────────────
-- Unindexed FKs make cascade deletes and joins scan the whole child.
CREATE INDEX IF NOT EXISTS idx_files_dedup_of ON files(dedup_of) WHERE dedup_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_uploaded_by ON files(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_direct_uploads_file_id ON direct_uploads(file_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_file_id ON upload_sessions(file_id);

-- ── Partial index for active (non-deleted) files ────────────
CREATE INDEX IF NOT EXISTS idx_files_active
  ON files(project_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- ── Lifecycle scanner index (exact shape from the plan) ─────
-- Serves the daily scan: active, unprotected, non-deleted files ordered by
-- last access within a project.
CREATE INDEX IF NOT EXISTS files_lifecycle_scan_idx
  ON files (project_id, last_accessed_at)
  WHERE deleted_at IS NULL
    AND lifecycle_state = 'active'
    AND protected_from_delete = false;

-- ── Content-dedup lookup ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_files_content_hash
  ON files(project_id, content_hash)
  WHERE deleted_at IS NULL AND content_hash IS NOT NULL;

-- ── Unique storage key per backend ──────────────────────────
-- file_objects already carries UNIQUE (storage_backend_id, storage_key) from
-- migration 006; assert it exists (older installs) without failing if present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'file_objects_backend_key_uniq'
       OR indexdef ILIKE '%UNIQUE%(storage_backend_id, storage_key)%'
  ) THEN
    CREATE UNIQUE INDEX file_objects_backend_key_uniq
      ON file_objects(storage_backend_id, storage_key);
  END IF;
END $$;

-- ── Retention support: created_at indexes on high-volume logs ─
-- The cleanup job prunes these by age; the index keeps the delete cheap.
CREATE INDEX IF NOT EXISTS idx_bandwidth_log_created_at ON bandwidth_log(created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at ON webhook_deliveries(created_at);
CREATE INDEX IF NOT EXISTS idx_video_playback_events_created_at ON video_playback_events(created_at);
