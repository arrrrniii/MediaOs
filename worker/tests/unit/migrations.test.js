const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

describe('migration files', () => {
  it('should be numbered without gaps or duplicates', () => {
    const numbers = migrationFiles().map((f) => parseInt(f.slice(0, 3), 10));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it('should name every file NNN_snake_case.sql', () => {
    for (const file of migrationFiles()) {
      expect(file).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
    }
  });
});

describe('005_users_memberships.sql', () => {
  const sql = fs.readFileSync(
    path.join(MIGRATIONS_DIR, '005_users_memberships.sql'),
    'utf8'
  );

  it('should create users with a unique email', () => {
    expect(sql).toMatch(/CREATE TABLE users/);
    expect(sql).toMatch(/email\s+VARCHAR\(255\) NOT NULL UNIQUE/);
  });

  it('should create account_memberships with cascading FKs', () => {
    expect(sql).toMatch(/CREATE TABLE account_memberships/);
    expect(sql).toMatch(/user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/account_id\s+UUID NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/);
  });

  it('should constrain role to the four known values', () => {
    expect(sql).toMatch(/CHECK \(role IN \('owner', 'admin', 'editor', 'viewer'\)\)/);
  });

  it('should allow a user only one membership per account', () => {
    expect(sql).toMatch(/UNIQUE \(user_id, account_id\)/);
  });

  it('should index both sides of the membership join', () => {
    expect(sql).toMatch(/CREATE INDEX idx_account_memberships_user_id/);
    expect(sql).toMatch(/CREATE INDEX idx_account_memberships_account_id/);
  });

  it('should keep updated_at current via triggers', () => {
    expect(sql).toMatch(/CREATE TRIGGER trg_users_updated_at/);
    expect(sql).toMatch(/CREATE TRIGGER trg_account_memberships_updated_at/);
  });

  it('should backfill users and owner memberships idempotently', () => {
    expect(sql).toMatch(/INSERT INTO users[\s\S]*ON CONFLICT \(email\) DO NOTHING/);
    expect(sql).toMatch(
      /INSERT INTO account_memberships[\s\S]*'owner'[\s\S]*ON CONFLICT \(user_id, account_id\) DO NOTHING/
    );
  });

  it('should leave the legacy accounts login columns in place', () => {
    expect(sql).not.toMatch(/ALTER TABLE accounts[\s\S]*DROP COLUMN/);
  });
});

describe('006_logical_assets.sql', () => {
  const sql = fs.readFileSync(
    path.join(MIGRATIONS_DIR, '006_logical_assets.sql'),
    'utf8'
  );

  it('should create storage_backends with a type check and nullable account scope', () => {
    expect(sql).toMatch(/CREATE TABLE storage_backends/);
    expect(sql).toMatch(/account_id\s+UUID REFERENCES accounts\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/CHECK \(type IN \('minio', 's3', 'r2', 'b2'\)\)/);
    expect(sql).toMatch(/CHECK \(status IN \('active', 'disabled'\)\)/);
  });

  it('should allow only one default backend per scope', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX idx_storage_backends_one_default/);
    expect(sql).toMatch(/COALESCE\(account_id, '00000000-0000-0000-0000-000000000000'::uuid\)/);
    expect(sql).toMatch(/WHERE is_default/);
  });

  it('should seed exactly one system-default MinIO backend, idempotently', () => {
    expect(sql).toMatch(/INSERT INTO storage_backends[\s\S]*'minio', 'Primary MinIO'/);
    expect(sql).toMatch(/WHERE NOT EXISTS \(\s*SELECT 1 FROM storage_backends WHERE account_id IS NULL AND is_default/);
  });

  it('should create file_objects with role, tier, and status checks', () => {
    expect(sql).toMatch(/CREATE TABLE file_objects/);
    expect(sql).toMatch(/file_id\s+UUID NOT NULL REFERENCES files\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/storage_backend_id\s+UUID NOT NULL REFERENCES storage_backends\(id\)/);
    expect(sql).toMatch(/CHECK \(role IN \([\s\S]*'source', 'optimized', 'thumbnail'/);
    expect(sql).toMatch(/CHECK \(storage_tier IN \('hot', 'warm', 'cold', 'archive'\)\)/);
    expect(sql).toMatch(/CHECK \(status IN \('pending', 'available', 'missing', 'corrupt'\)\)/);
    expect(sql).toMatch(/CHECK \(size >= 0\)/);
  });

  it('should index file_objects and enforce backend+key uniqueness', () => {
    expect(sql).toMatch(/CREATE INDEX idx_file_objects_file /);
    expect(sql).toMatch(/CREATE INDEX idx_file_objects_file_role/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX idx_file_objects_backend_key ON file_objects\(storage_backend_id, storage_key\)/);
    expect(sql).toMatch(/CREATE INDEX idx_file_objects_status/);
    expect(sql).toMatch(/CREATE INDEX idx_file_objects_tier/);
  });

  it('should add lifecycle and preservation columns to files without dropping legacy ones', () => {
    expect(sql).toMatch(/ALTER TABLE files ADD COLUMN IF NOT EXISTS lifecycle_state VARCHAR\(20\) NOT NULL DEFAULT 'active'/);
    expect(sql).toMatch(/lifecycle_state IN \([\s\S]*'archived'[\s\S]*'legal_hold'[\s\S]*'deleted'\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS access_count BIGINT NOT NULL DEFAULT 0 CHECK \(access_count >= 0\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS protected_from_delete BOOLEAN NOT NULL DEFAULT FALSE/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS checksum VARCHAR\(64\)/);
    expect(sql).not.toMatch(/ALTER TABLE files[\s\S]*DROP COLUMN/);
  });

  it('should backfill an optimized object per file, idempotently', () => {
    expect(sql).toMatch(/INSERT INTO file_objects[\s\S]*'optimized'/);
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM file_objects o WHERE o\.file_id = f\.id AND o\.role = 'optimized'/);
  });

  it('should backfill a thumbnail object for files that have one', () => {
    expect(sql).toMatch(/INSERT INTO file_objects[\s\S]*'thumbnail'[\s\S]*FROM files f\s*WHERE f\.thumbnail_key IS NOT NULL/);
  });
});

describe('012_video.sql', () => {
  const sql = fs.readFileSync(
    path.join(MIGRATIONS_DIR, '012_video.sql'),
    'utf8'
  );

  it('should create video_renditions with a per-file, per-height uniqueness', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS video_renditions/);
    expect(sql).toMatch(/file_id\s+UUID NOT NULL REFERENCES files\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/CHECK \(status IN \('pending', 'ready', 'failed'\)\)/);
    expect(sql).toMatch(/UNIQUE \(file_id, height\)/);
  });

  it('should create subtitles with a per-file, per-language uniqueness', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS subtitles/);
    expect(sql).toMatch(/lang\s+VARCHAR\(10\) NOT NULL/);
    expect(sql).toMatch(/UNIQUE \(file_id, lang\)/);
  });

  it('should create video_playback_events with a bounded event enum', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS video_playback_events/);
    expect(sql).toMatch(/CHECK \(event IN \('play', 'pause', 'ended', 'seek', 'error', 'segment'\)\)/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_video_playback_events_file/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_video_playback_events_project/);
  });

  it('should add has_hls, video_status, and poster_key to files idempotently', () => {
    expect(sql).toMatch(/ALTER TABLE files ADD COLUMN IF NOT EXISTS has_hls BOOLEAN NOT NULL DEFAULT FALSE/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS video_status VARCHAR\(20\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS poster_key VARCHAR\(500\)/);
    expect(sql).not.toMatch(/DROP COLUMN/);
  });
});

describe('013_db_hardening.sql', () => {
  const sql = fs.readFileSync(
    path.join(MIGRATIONS_DIR, '013_db_hardening.sql'),
    'utf8'
  );

  it('adds status/access/size CHECK constraints on files', () => {
    expect(sql).toMatch(/files_status_check/);
    expect(sql).toMatch(/files_access_check/);
    expect(sql).toMatch(/files_size_nonneg/);
  });

  it('guards non-negative counters and rate limits', () => {
    expect(sql).toMatch(/projects_storage_used_nonneg/);
    expect(sql).toMatch(/projects_file_count_nonneg/);
    expect(sql).toMatch(/api_keys_rate_limit_nonneg/);
  });

  it('adds the missing foreign-key indexes', () => {
    expect(sql).toMatch(/idx_files_dedup_of/);
    expect(sql).toMatch(/idx_files_uploaded_by/);
    expect(sql).toMatch(/idx_direct_uploads_file_id/);
    expect(sql).toMatch(/idx_upload_sessions_file_id/);
  });

  it('creates the lifecycle scan index exactly as specified', () => {
    expect(sql).toMatch(/files_lifecycle_scan_idx/);
    expect(sql).toMatch(/lifecycle_state = 'active'/);
    expect(sql).toMatch(/protected_from_delete = false/);
  });

  it('is idempotent (guards constraints, IF NOT EXISTS indexes, no drops)', () => {
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(sql).not.toMatch(/DROP /);
  });
});
