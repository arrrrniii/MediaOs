const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// Single advisory lock key for migrations — prevents concurrent runners
// (e.g. two worker containers booting at once) from applying the same
// migration twice or deadlocking on DDL.
const MIGRATION_LOCK_KEY = 0x6d656469; // 'medi'

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

function readMigrationFiles() {
  const dir = path.join(__dirname);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8');
      return { name, sql, checksum: checksum(sql) };
    });
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      checksum VARCHAR(64),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Older installs predate the checksum column.
  await client.query(
    'ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum VARCHAR(64)'
  );
}

// Verify that every applied migration still matches its file on disk and
// that no applied migration is missing from disk. Returns a list of
// problems (empty = healthy).
async function verify(pool) {
  const problems = [];
  const files = readMigrationFiles();
  const byName = new Map(files.map((f) => [f.name, f]));

  const { rows: applied } = await pool.query(
    'SELECT name, checksum FROM _migrations ORDER BY id'
  );

  for (const row of applied) {
    const file = byName.get(row.name);
    if (!file) {
      problems.push(`Applied migration missing from disk: ${row.name}`);
      continue;
    }
    if (row.checksum && row.checksum !== file.checksum) {
      problems.push(
        `Checksum mismatch for ${row.name}: file was modified after being applied`
      );
    }
  }

  const appliedSet = new Set(applied.map((r) => r.name));
  const lastApplied = applied.length ? applied[applied.length - 1].name : '';
  for (const file of files) {
    // A pending migration that sorts BEFORE an applied one would silently
    // apply out of order — flag it.
    if (!appliedSet.has(file.name) && file.name < lastApplied) {
      problems.push(
        `Out-of-order pending migration: ${file.name} sorts before last applied ${lastApplied}`
      );
    }
  }

  return problems;
}

async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await ensureMigrationsTable(client);

    const { rows: applied } = await client.query(
      'SELECT name FROM _migrations ORDER BY id'
    );
    const appliedSet = new Set(applied.map((r) => r.name));

    for (const file of readMigrationFiles()) {
      if (appliedSet.has(file.name)) continue;

      console.log(`Applying migration: ${file.name}`);
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query(
          'INSERT INTO _migrations (name, checksum) VALUES ($1, $2)',
          [file.name, file.checksum]
        );
        await client.query('COMMIT');
        console.log(`Applied: ${file.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Migration failed: ${file.name}`, err.message);
        throw err;
      }
    }

    const problems = await verify(pool);
    if (problems.length > 0) {
      for (const p of problems) console.error(`Migration verification: ${p}`);
      throw new Error('Migration verification failed');
    }

    console.log('All migrations applied and verified');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    client.release();
  }
}

module.exports = { migrate, verify };

// CLI: `npm run migrate` applies pending migrations; `npm run migrate -- --verify`
// only checks that applied migrations match the files on disk.
if (require.main === module) {
  const config = require('../src/config');
  const pool = new Pool({
    host: config.pg.host,
    port: config.pg.port,
    database: config.pg.database,
    user: config.pg.user,
    password: config.pg.password,
    max: 2,
  });

  const verifyOnly = process.argv.includes('--verify');
  const run = verifyOnly
    ? verify(pool).then((problems) => {
        if (problems.length > 0) {
          for (const p of problems) console.error(`Migration verification: ${p}`);
          process.exitCode = 1;
        } else {
          console.log('Migration verification passed');
        }
      })
    : migrate(pool);

  run
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
