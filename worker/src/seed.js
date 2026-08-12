const config = require('./config');
const { query } = require('./db');
const { hashPassword, ensureOwnerUser } = require('./services/identityService');

async function seedAdmin() {
  // Check if any accounts exist
  const { rows } = await query('SELECT COUNT(*) FROM accounts');
  const count = parseInt(rows[0].count);

  if (count > 0) return;

  // If ADMIN_EMAIL and ADMIN_PASSWORD are set, auto-create the admin.
  // Otherwise, skip — the dashboard setup wizard will handle it.
  if (!config.adminEmail || !config.adminPassword) {
    console.log('No accounts found — open the dashboard to run setup wizard.');
    return;
  }

  const hash = await hashPassword(config.adminPassword);

  const { rows: created } = await query(
    `INSERT INTO accounts (name, email, password_hash, plan, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [config.adminName, config.adminEmail, hash, 'free', 'active']
  );

  await ensureOwnerUser({
    accountId: created[0].id,
    name: config.adminName,
    email: config.adminEmail,
    passwordHash: hash,
  });

  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  Admin account created from env vars!');
  console.log(`  Email: ${config.adminEmail}`);
  console.log('═══════════════════════════════════════════════');
  console.log('');
}

module.exports = { seedAdmin };
