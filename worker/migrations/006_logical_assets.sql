-- ═══════════════════════════════════════════════════════════
--  Logical Asset Model + Original Preservation (Phase 2 & 3)
--
--  Introduces a separation between a logical file (the `files` row the
--  API exposes) and the physical byte-copies backing it (`file_objects`).
--  A single logical file can now own several physical objects — a
--  preserved source, an optimized rendition, a thumbnail, video
--  renditions — each stored on a `storage_backends` target and tracked
--  independently for size, checksum, tier, and health.
--
--  All legacy columns on `files` (storage_key, thumbnail_key, size,
--  original_size) are intentionally kept so existing reads keep working
--  during and after the transition.
-- ═══════════════════════════════════════════════════════════

-- ── Storage backends ────────────────────────────────────
-- A storage target. Today the only real backend is the system-default
-- MinIO bucket, whose credentials the worker reads from env/config (so
-- configuration_encrypted stays NULL). Phase 6 adds S3/R2/B2 backends
-- with encrypted per-backend configuration.
CREATE TABLE storage_backends (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id               UUID REFERENCES accounts(id) ON DELETE CASCADE, -- NULL = system-wide default
    type                     VARCHAR(20) NOT NULL CHECK (type IN ('minio', 's3', 'r2', 'b2')),
    name                     VARCHAR(255) NOT NULL,
    configuration_encrypted  TEXT,                                  -- NULL for the env-configured system MinIO
    status                   VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    is_default               BOOLEAN NOT NULL DEFAULT FALSE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one default backend per scope. System-wide rows (account_id NULL)
-- collapse to the all-zeros sentinel so they share one uniqueness bucket.
CREATE UNIQUE INDEX idx_storage_backends_one_default
    ON storage_backends ((COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    WHERE is_default;

CREATE INDEX idx_storage_backends_account ON storage_backends(account_id);

CREATE TRIGGER trg_storage_backends_updated_at BEFORE UPDATE ON storage_backends
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Seed the system-default MinIO backend. Its credentials live in worker
-- config/env, so configuration_encrypted is left NULL. Idempotent so a
-- re-run does not create a second default.
INSERT INTO storage_backends (account_id, type, name, configuration_encrypted, status, is_default)
SELECT NULL, 'minio', 'Primary MinIO', NULL, 'active', TRUE
WHERE NOT EXISTS (
    SELECT 1 FROM storage_backends WHERE account_id IS NULL AND is_default
);

-- ── File objects ────────────────────────────────────────
-- A physical byte-copy backing a logical file. Roles distinguish a
-- preserved source from the optimized rendition, thumbnails, and video
-- variants.
CREATE TABLE file_objects (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id             UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    role                VARCHAR(20) NOT NULL CHECK (role IN (
                            'source', 'optimized', 'thumbnail',
                            'video_720p', 'video_1080p', 'video_480p', 'video_360p',
                            'poster', 'hls')),
    storage_backend_id  UUID NOT NULL REFERENCES storage_backends(id),
    storage_key         VARCHAR(500) NOT NULL,
    mime_type           VARCHAR(100) NOT NULL,
    size                BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
    checksum            VARCHAR(64),
    storage_tier        VARCHAR(20) NOT NULL DEFAULT 'hot' CHECK (storage_tier IN ('hot', 'warm', 'cold', 'archive')),
    status              VARCHAR(20) NOT NULL DEFAULT 'available' CHECK (status IN ('pending', 'available', 'missing', 'corrupt')),
    width               INTEGER,
    height              INTEGER,
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at         TIMESTAMPTZ
);

CREATE INDEX idx_file_objects_file ON file_objects(file_id);
CREATE INDEX idx_file_objects_file_role ON file_objects(file_id, role);
CREATE UNIQUE INDEX idx_file_objects_backend_key ON file_objects(storage_backend_id, storage_key);
CREATE INDEX idx_file_objects_status ON file_objects(status);
CREATE INDEX idx_file_objects_tier ON file_objects(storage_tier);

-- ── Files: lifecycle + preservation columns ─────────────
ALTER TABLE files ADD COLUMN IF NOT EXISTS lifecycle_state VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN (
        'active', 'cold_candidate', 'archiving', 'archived', 'restoring',
        'delete_candidate', 'legal_hold', 'damaged', 'repairing', 'deleted'));
ALTER TABLE files ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN IF NOT EXISTS access_count BIGINT NOT NULL DEFAULT 0 CHECK (access_count >= 0);
ALTER TABLE files ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN IF NOT EXISTS protected_from_delete BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE files ADD COLUMN IF NOT EXISTS checksum VARCHAR(64);          -- source/canonical checksum

CREATE INDEX IF NOT EXISTS idx_files_lifecycle_state ON files(lifecycle_state);

-- ── Backfill file_objects from existing files ───────────
-- Every existing file becomes an 'optimized' object (the closest existing
-- canonical role — 'source' would misrepresent stored-as-is files). Rows
-- with a thumbnail also get a 'thumbnail' object. Guarded with NOT EXISTS
-- so re-running the migration is safe.
INSERT INTO file_objects (file_id, role, storage_backend_id, storage_key, mime_type, size, storage_tier, status, width, height)
SELECT
    f.id, 'optimized',
    (SELECT id FROM storage_backends WHERE account_id IS NULL AND is_default LIMIT 1),
    f.storage_key, f.mime_type, COALESCE(f.size, 0), 'hot', 'available', f.width, f.height
FROM files f
WHERE f.storage_key IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM file_objects o WHERE o.file_id = f.id AND o.role = 'optimized'
  );

INSERT INTO file_objects (file_id, role, storage_backend_id, storage_key, mime_type, size, storage_tier, status)
SELECT
    f.id, 'thumbnail',
    (SELECT id FROM storage_backends WHERE account_id IS NULL AND is_default LIMIT 1),
    f.thumbnail_key, 'image/webp', 0, 'hot', 'available'
FROM files f
WHERE f.thumbnail_key IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM file_objects o WHERE o.file_id = f.id AND o.role = 'thumbnail'
  );

-- lifecycle_state defaults to 'active', which is correct for every
-- existing file, so no explicit update is needed.
