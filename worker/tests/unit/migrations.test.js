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
