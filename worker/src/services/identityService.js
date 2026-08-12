const bcrypt = require('bcrypt');
const { query } = require('../db');

const BCRYPT_ROUNDS = 12;

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function findUserByEmail(email) {
  const { rows } = await query(
    "SELECT id, email, name, password_hash, status FROM users WHERE email = $1 AND status = 'active'",
    [email]
  );
  return rows[0] || null;
}

// Accounts a user can act on, with the role that grants the access.
async function listAccountsForUser(userId) {
  const { rows } = await query(
    `SELECT a.id, a.name, a.plan, m.role
     FROM account_memberships m
     JOIN accounts a ON a.id = m.account_id
     WHERE m.user_id = $1 AND a.status = 'active'
     ORDER BY m.created_at ASC`,
    [userId]
  );
  return rows;
}

/**
 * Create (or reuse) the login identity for an account and link the two with
 * an 'owner' membership. Shared by seed, first-boot setup, and the legacy
 * login fallback so identity creation lives in exactly one place.
 */
async function ensureOwnerUser({ accountId, name, email, passwordHash }) {
  const { rows: inserted } = await query(
    `INSERT INTO users (email, name, password_hash, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email, name, status`,
    [email, name, passwordHash]
  );

  let user = inserted[0];
  if (!user) {
    const { rows } = await query(
      'SELECT id, email, name, status FROM users WHERE email = $1',
      [email]
    );
    user = rows[0];
  }
  if (!user) return null;

  await query(
    `INSERT INTO account_memberships (user_id, account_id, role)
     VALUES ($1, $2, 'owner')
     ON CONFLICT (user_id, account_id) DO NOTHING`,
    [user.id, accountId]
  );

  return user;
}

module.exports = {
  BCRYPT_ROUNDS,
  hashPassword,
  findUserByEmail,
  listAccountsForUser,
  ensureOwnerUser,
};
