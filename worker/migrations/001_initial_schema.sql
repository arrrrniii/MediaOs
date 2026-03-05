-- ═══════════════════════════════════════════════════════════
--  MediaOS — Initial Schema
-- ═══════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Accounts ────────────────────────────────────────────
-- An account is the top-level entity (a paying customer, org, or individual)
CREATE TABLE accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255),                          -- bcrypt hash, nullable for API-only accounts
    plan            VARCHAR(50) NOT NULL DEFAULT 'free',   -- free, pro, business, enterprise
    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active, suspended, deleted
    metadata        JSONB DEFAULT '{}',                    -- extensible: company, address, etc.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_accounts_email ON accounts(email);
CREATE INDEX idx_accounts_status ON accounts(status);

-- ── Projects ────────────────────────────────────────────
-- Each account can have multiple projects (e.g. staging, production, mobile)
CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(100) NOT NULL,                 -- URL-safe identifier
    description     TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active, paused, deleted
    signing_secret  VARCHAR(64) NOT NULL,                  -- for signed URLs, auto-generated
    settings        JSONB DEFAULT '{
        "max_file_size": 104857600,
        "allowed_types": ["image", "video", "file"],
        "webp_quality": 80,
        "max_width": 1600,
        "max_height": 1600,
        "default_access": "public"
    }',
    storage_used    BIGINT NOT NULL DEFAULT 0,             -- bytes, updated on upload/delete
    file_count      INTEGER NOT NULL DEFAULT 0,            -- updated on upload/delete
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_projects_account_slug ON projects(account_id, slug);
CREATE INDEX idx_projects_account_id ON projects(account_id);
CREATE INDEX idx_projects_status ON projects(status);

-- ── API Keys ────────────────────────────────────────────
-- Multiple keys per project with granular scopes
CREATE TABLE api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL DEFAULT 'Default Key',
    -- Key format: mv_live_xxxxxxxxxxxx or mv_test_xxxxxxxxxxxx
    -- We store prefix (first 12 chars) in plaintext for lookup
    -- Full key is hashed with SHA-256 for validation
    key_prefix      VARCHAR(20) NOT NULL,                  -- "mv_live_abc1" — for fast lookup
    key_hash        VARCHAR(64) NOT NULL,                  -- SHA-256 of full key
    scopes          TEXT[] NOT NULL DEFAULT '{upload,read}', -- upload, read, delete, admin
    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active, revoked
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,                           -- null = no expiry
    rate_limit      INTEGER DEFAULT 100,                   -- requests per minute
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX idx_api_keys_project_id ON api_keys(project_id);
CREATE INDEX idx_api_keys_status ON api_keys(status);

-- ── Files ───────────────────────────────────────────────
-- Every uploaded file is tracked with full metadata
CREATE TABLE files (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Storage info
    storage_key     VARCHAR(500) NOT NULL,                 -- full MinIO key: {project_id}/{folder}/{slug}.ext
    filename        VARCHAR(255) NOT NULL,                 -- display name: hero-banner-a8x3k2.webp
    original_name   VARCHAR(500),                          -- what the user uploaded: "My Photo.JPG"
    folder          VARCHAR(255),                          -- optional subfolder
    -- File info
    type            VARCHAR(20) NOT NULL,                  -- image, video, file
    mime_type       VARCHAR(100) NOT NULL,
    size            BIGINT NOT NULL,                       -- final size in bytes
    original_size   BIGINT,                                -- pre-processing size
    -- Image metadata
    width           INTEGER,
    height          INTEGER,
    -- Video metadata
    duration        REAL,                                  -- seconds
    thumbnail_key   VARCHAR(500),                          -- thumbnail storage key
    -- Processing
    status          VARCHAR(20) NOT NULL DEFAULT 'done',   -- uploading, processing, done, failed
    processing_ms   INTEGER,                               -- time taken in ms
    error_message   TEXT,                                  -- if failed
    -- Access control
    access          VARCHAR(20) NOT NULL DEFAULT 'public', -- public, private, signed
    -- Metadata
    metadata        JSONB DEFAULT '{}',                    -- extensible: alt text, tags, etc.
    uploaded_by     UUID REFERENCES api_keys(id),          -- which key uploaded this
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ                            -- soft delete
);

CREATE INDEX idx_files_project_id ON files(project_id);
CREATE INDEX idx_files_storage_key ON files(storage_key);
CREATE INDEX idx_files_project_folder ON files(project_id, folder);
CREATE INDEX idx_files_project_type ON files(project_id, type);
CREATE INDEX idx_files_status ON files(status);
CREATE INDEX idx_files_created_at ON files(project_id, created_at DESC);
CREATE INDEX idx_files_deleted_at ON files(deleted_at) WHERE deleted_at IS NULL;

-- ── Updated_at trigger ──────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_accounts_updated_at BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_api_keys_updated_at BEFORE UPDATE ON api_keys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_files_updated_at BEFORE UPDATE ON files
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
