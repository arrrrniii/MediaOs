-- ═══════════════════════════════════════════════════════════
--  Delivery + Uploads (Phase 8a)
--
--  Additive schema for named transform variants, a persistent transform
--  cache, presigned one-time direct uploads, resumable multipart uploads,
--  content-hash dedup, and per-file cache versioning/purge. Every statement
--  is idempotent (IF NOT EXISTS / guarded) so a re-run is a no-op.
-- ═══════════════════════════════════════════════════════════

-- ── Named variants ──────────────────────────────────────
-- A reusable, named transform preset scoped to a project (e.g. 'thumbnail',
-- 'card', 'hero'). Serving via /img/v/:variant/... resolves the preset here,
-- so callers never encode raw dimensions and a project can restrict delivery
-- to an allowlist of named variants.
CREATE TABLE IF NOT EXISTS named_variants (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name         VARCHAR(60) NOT NULL,
    mode         VARCHAR(10) NOT NULL CHECK (mode IN ('fit', 'fill', 'auto', 'force')),
    width        INTEGER NOT NULL CHECK (width >= 0 AND width <= 8192),
    height       INTEGER NOT NULL CHECK (height >= 0 AND height <= 8192),
    format       VARCHAR(10) CHECK (format IN ('auto', 'webp', 'avif', 'jpeg', 'png')),
    quality      INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_named_variants_project_name
    ON named_variants(project_id, name);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_named_variants_updated_at') THEN
        CREATE TRIGGER trg_named_variants_updated_at BEFORE UPDATE ON named_variants
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END $$;

-- ── Direct uploads (one-time presigned grants) ──────────
-- A single-use grant to upload one object directly to the worker. Created via
-- POST /api/v1/uploads/direct; the returned token authorizes exactly one PUT
-- that runs the normal processing pipeline and attaches file_id.
CREATE TABLE IF NOT EXISTS direct_uploads (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    token_hash       VARCHAR(64) NOT NULL,
    storage_key      VARCHAR(500),
    status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'completed', 'expired', 'aborted')),
    max_bytes        BIGINT,
    content_type     VARCHAR(100),
    access           VARCHAR(20),
    folder           VARCHAR(255),
    idempotency_key  VARCHAR(200),
    file_id          UUID REFERENCES files(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_direct_uploads_project ON direct_uploads(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_uploads_token ON direct_uploads(token_hash);
CREATE INDEX IF NOT EXISTS idx_direct_uploads_idempotency ON direct_uploads(idempotency_key);

-- ── Upload sessions (resumable multipart) ───────────────
-- A resumable multipart upload. Parts are stored as temp objects and composed
-- on completion, then the assembled bytes run through the normal pipeline.
CREATE TABLE IF NOT EXISTS upload_sessions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    upload_id        VARCHAR(200),
    storage_key      VARCHAR(500),
    filename         VARCHAR(500),
    content_type     VARCHAR(100),
    access           VARCHAR(20),
    folder           VARCHAR(255),
    parts            JSONB NOT NULL DEFAULT '[]',
    total_bytes      BIGINT,
    received_bytes   BIGINT NOT NULL DEFAULT 0,
    status           VARCHAR(20) NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'completed', 'aborted', 'expired')),
    idempotency_key  VARCHAR(200),
    file_id          UUID REFERENCES files(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_project ON upload_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_idempotency ON upload_sessions(idempotency_key);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_upload_sessions_updated_at') THEN
        CREATE TRIGGER trg_upload_sessions_updated_at BEFORE UPDATE ON upload_sessions
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END $$;

-- ── Files: dedup + cache versioning ─────────────────────
-- content_hash is the checksum of the SOURCE/canonical bytes, used as the
-- dedup key within a project. dedup_of points at the logical file whose
-- physical objects this row reuses (no bytes re-stored). cache_version is
-- bumped to purge a file's cached transforms.
ALTER TABLE files ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64);
ALTER TABLE files ADD COLUMN IF NOT EXISTS dedup_of UUID REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE files ADD COLUMN IF NOT EXISTS cache_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_files_content_hash
    ON files(project_id, content_hash) WHERE deleted_at IS NULL;

-- ── Transform cache metadata ────────────────────────────
-- One row per rendered-and-stored transform, so a purge can find and delete
-- the physical cache objects. The physical key embeds the file's
-- cache_version; bumping it makes old keys unreachable even without deleting.
CREATE TABLE IF NOT EXISTS transform_cache (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID,
    file_id      UUID REFERENCES files(id) ON DELETE CASCADE,
    variant_key  VARCHAR(200) NOT NULL,
    storage_key  VARCHAR(500) NOT NULL,
    format       VARCHAR(10),
    size         BIGINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transform_cache_file_variant
    ON transform_cache(file_id, variant_key);
CREATE INDEX IF NOT EXISTS idx_transform_cache_file ON transform_cache(file_id);
