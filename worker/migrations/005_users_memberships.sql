-- ═══════════════════════════════════════════════════════════
--  Users & Account Memberships
--
--  Splits login identity (users) from tenancy (accounts). A user
--  reaches an account only through an account_memberships row,
--  which also carries their role in that account.
--
--  accounts.email / accounts.password_hash are intentionally left
--  in place for backwards compatibility with the legacy
--  POST /api/v1/accounts/login endpoint; a later release drops them.
-- ═══════════════════════════════════════════════════════════

-- ── Users ───────────────────────────────────────────────
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) NOT NULL UNIQUE,
    name            VARCHAR(255) NOT NULL,
    password_hash   VARCHAR(255),                          -- bcrypt hash, nullable for SSO-only users
    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active, suspended, deleted
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Account Memberships ─────────────────────────────────
-- The only path from a user to an account. No membership, no access.
CREATE TABLE account_memberships (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    role            VARCHAR(20) NOT NULL
                    CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, account_id)
);

CREATE INDEX idx_account_memberships_user_id ON account_memberships(user_id);
CREATE INDEX idx_account_memberships_account_id ON account_memberships(account_id);

CREATE TRIGGER trg_account_memberships_updated_at BEFORE UPDATE ON account_memberships
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Backfill ────────────────────────────────────────────
-- Every existing account that doubles as a login identity becomes a
-- user with an 'owner' membership on that account.
INSERT INTO users (email, name, password_hash, status)
SELECT a.email, a.name, a.password_hash, 'active'
FROM accounts a
WHERE a.email IS NOT NULL
  AND a.password_hash IS NOT NULL
ON CONFLICT (email) DO NOTHING;

INSERT INTO account_memberships (user_id, account_id, role)
SELECT u.id, a.id, 'owner'
FROM accounts a
JOIN users u ON u.email = a.email
WHERE a.email IS NOT NULL
  AND a.password_hash IS NOT NULL
ON CONFLICT (user_id, account_id) DO NOTHING;
