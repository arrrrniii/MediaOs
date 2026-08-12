/**
 * Storage backends API (dashboard-facing, session-scoped, admin+).
 *
 * Lets an account admin register, verify, and manage the remote (cold) storage
 * backends their archives go to — AWS S3, Cloudflare R2, Backblaze B2, or a
 * secondary MinIO. The whole connection config, including the secret access
 * key, is encrypted into storage_backends.configuration_encrypted on write and
 * NEVER returned: list/create/update responses carry only non-secret
 * connection info (type, name, endpoint, bucket, region, status). Secrets are
 * write-only.
 *
 * Everything is account-scoped: a backend belonging to another account (or the
 * system-wide default, account_id NULL) is reported as 404, so nothing leaks
 * across tenants.
 */

const { Router } = require('express');
const { sessionScope, requireRole } = require('../middleware/sessionAuth');
const { query, withTransaction } = require('../db');
const secretBox = require('../utils/secretBox');
const storageBackendService = require('../services/storageBackendService');

const router = Router();

const ALLOWED_TYPES = ['s3', 'r2', 'b2', 'minio'];

/**
 * Non-secret view of a backend row for API responses. Decrypts the config only
 * to surface endpoint/region/bucket; the access key id and secret are dropped
 * entirely so no response can ever carry a credential.
 */
function redactBackend(row) {
  let endpoint = null;
  let region = null;
  let bucket = null;
  let forcePathStyle = null;
  try {
    if (row.configuration_encrypted) {
      const cfg = secretBox.decryptJson(row.configuration_encrypted);
      endpoint = cfg.endpoint || null;
      region = cfg.region || null;
      bucket = cfg.bucket || null;
      forcePathStyle = cfg.forcePathStyle === undefined ? null : !!cfg.forcePathStyle;
    }
  } catch {
    // Key missing/rotated or blob tampered — expose nothing rather than throw.
  }
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    endpoint,
    region,
    bucket,
    force_path_style: forcePathStyle,
    status: row.status,
    is_cold_default: row.is_cold_default,
    last_verified_at: row.last_verified_at,
    created_at: row.created_at,
  };
}

function validationError(res, message, code = 'VALIDATION_ERROR') {
  return res.status(400).json({ error: message, code });
}

// POST /api/v1/storage/backends — create a backend (encrypts credentials).
router.post('/api/v1/storage/backends', ...sessionScope, requireRole('admin'), async (req, res, next) => {
  try {
    if (!secretBox.hasKey()) {
      return res.status(503).json({
        error: 'Storage encryption is not configured on the server (STORAGE_ENCRYPTION_KEY).',
        code: 'ENCRYPTION_NOT_CONFIGURED',
      });
    }
    const b = req.body || {};
    const type = String(b.type || '').toLowerCase();
    if (!ALLOWED_TYPES.includes(type)) {
      return validationError(res, `type must be one of: ${ALLOWED_TYPES.join(', ')}`);
    }
    if (!b.name || typeof b.name !== 'string') return validationError(res, 'name is required');
    if (!b.bucket || typeof b.bucket !== 'string') return validationError(res, 'bucket is required');
    if (!b.accessKeyId || !b.secretAccessKey) {
      return validationError(res, 'accessKeyId and secretAccessKey are required', 'CREDENTIALS_REQUIRED');
    }
    // AWS S3 identifies the endpoint from region; every other type needs one.
    if (type !== 's3' && !b.endpoint) {
      return validationError(res, `endpoint is required for type "${type}"`);
    }

    const config = {
      endpoint: b.endpoint || null,
      region: b.region || 'us-east-1',
      bucket: b.bucket,
      accessKeyId: b.accessKeyId,
      secretAccessKey: b.secretAccessKey,
      forcePathStyle: b.forcePathStyle !== undefined
        ? !!b.forcePathStyle
        : (type === 'minio' || type === 'b2' || type === 'r2'),
    };
    const encrypted = secretBox.encryptJson(config);
    const isCold = b.is_cold_default === true;

    const row = await withTransaction(async (client) => {
      if (isCold) {
        // At most one cold default per account (enforced by a unique index).
        await client.query(
          `UPDATE storage_backends SET is_cold_default = FALSE
             WHERE account_id = $1 AND is_cold_default`,
          [req.account.id]
        );
      }
      const { rows } = await client.query(
        `INSERT INTO storage_backends
           (account_id, type, name, configuration_encrypted, status, is_default, is_cold_default)
         VALUES ($1, $2, $3, $4, 'active', FALSE, $5)
         RETURNING id, account_id, type, name, configuration_encrypted, status, is_cold_default, last_verified_at, created_at`,
        [req.account.id, type, b.name, encrypted, isCold]
      );
      return rows[0];
    });

    res.status(201).json({ data: redactBackend(row) });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/storage/backends — list this account's backends (redacted).
router.get('/api/v1/storage/backends', ...sessionScope, requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, account_id, type, name, configuration_encrypted, status, is_cold_default, last_verified_at, created_at
         FROM storage_backends
        WHERE account_id = $1
        ORDER BY created_at DESC`,
      [req.account.id]
    );
    res.json({ data: rows.map(redactBackend) });
  } catch (err) {
    next(err);
  }
});

/** Load an account-scoped backend row, or send 404. */
async function loadOwnedBackend(req, res) {
  const { rows } = await query(
    `SELECT id, account_id, type, name, configuration_encrypted, status, is_cold_default, last_verified_at, created_at
       FROM storage_backends WHERE id = $1 AND account_id = $2`,
    [req.params.id, req.account.id]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Storage backend not found', code: 'NOT_FOUND' });
    return null;
  }
  return rows[0];
}

// PATCH /api/v1/storage/backends/:id — update name/status/cold-default or
// rotate credentials. Never returns secrets.
router.patch('/api/v1/storage/backends/:id', ...sessionScope, requireRole('admin'), async (req, res, next) => {
  try {
    const existing = await loadOwnedBackend(req, res);
    if (!existing) return;

    const b = req.body || {};
    const sets = [];
    const params = [existing.id];

    if (typeof b.name === 'string' && b.name.length > 0) {
      params.push(b.name);
      sets.push(`name = $${params.length}`);
    }
    if (typeof b.status === 'string') {
      if (!['active', 'disabled'].includes(b.status)) {
        return validationError(res, "status must be 'active' or 'disabled'");
      }
      params.push(b.status);
      sets.push(`status = $${params.length}`);
    }

    // Credential/connection rotation: if any config field is present, decrypt
    // the current config, merge, and re-encrypt. Secrets never leave the server.
    const rotatingFields = ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey', 'forcePathStyle'];
    if (rotatingFields.some((f) => b[f] !== undefined)) {
      if (!secretBox.hasKey()) {
        return res.status(503).json({ error: 'Storage encryption is not configured', code: 'ENCRYPTION_NOT_CONFIGURED' });
      }
      let current = {};
      try { current = existing.configuration_encrypted ? secretBox.decryptJson(existing.configuration_encrypted) : {}; } catch { current = {}; }
      const merged = { ...current };
      for (const f of rotatingFields) if (b[f] !== undefined) merged[f] = f === 'forcePathStyle' ? !!b[f] : b[f];
      params.push(secretBox.encryptJson(merged));
      sets.push(`configuration_encrypted = $${params.length}`);
    }

    const makeCold = b.is_cold_default === true;

    const row = await withTransaction(async (client) => {
      if (makeCold) {
        await client.query(
          `UPDATE storage_backends SET is_cold_default = FALSE
             WHERE account_id = $1 AND is_cold_default AND id <> $2`,
          [req.account.id, existing.id]
        );
        params.push(true);
        sets.push(`is_cold_default = $${params.length}`);
      } else if (b.is_cold_default === false) {
        params.push(false);
        sets.push(`is_cold_default = $${params.length}`);
      }

      if (sets.length === 0) return existing;
      const { rows } = await client.query(
        `UPDATE storage_backends SET ${sets.join(', ')}
          WHERE id = $1
        RETURNING id, account_id, type, name, configuration_encrypted, status, is_cold_default, last_verified_at, created_at`,
        params
      );
      return rows[0];
    });

    storageBackendService.invalidateClient(existing.id);
    res.json({ data: redactBackend(row) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/storage/backends/:id — blocked while any object references it.
router.delete('/api/v1/storage/backends/:id', ...sessionScope, requireRole('admin'), async (req, res, next) => {
  try {
    const existing = await loadOwnedBackend(req, res);
    if (!existing) return;

    const { rows: refs } = await query(
      `SELECT COUNT(*)::int AS n FROM file_objects WHERE storage_backend_id = $1`,
      [existing.id]
    );
    if (refs[0] && refs[0].n > 0) {
      return res.status(409).json({
        error: `Backend still holds ${refs[0].n} object(s); restore or move them before deleting.`,
        code: 'BACKEND_IN_USE',
      });
    }

    await query('DELETE FROM storage_backends WHERE id = $1 AND account_id = $2', [existing.id, req.account.id]);
    storageBackendService.invalidateClient(existing.id);
    res.json({ deleted: true, id: existing.id });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/storage/backends/:id/verify — probe connectivity.
router.post('/api/v1/storage/backends/:id/verify', ...sessionScope, requireRole('admin'), async (req, res, next) => {
  try {
    const existing = await loadOwnedBackend(req, res);
    if (!existing) return;

    const probeKey = `__mediaos_probe__/${existing.id}-${Date.now()}`;
    try {
      const client = storageBackendService.getBackendClient(existing);
      await client.putBuffer(probeKey, Buffer.from('mediaos-probe'), 'text/plain');
      await client.statObject(probeKey);
      await client.removeObject(probeKey);
    } catch (err) {
      // Report failure without leaking secrets (err.message from the SDK is
      // safe — it never echoes the secret key).
      return res.status(200).json({ verified: false, error: err.message || 'Verification failed' });
    }

    const { rows } = await query(
      `UPDATE storage_backends SET last_verified_at = NOW(), status = 'active'
        WHERE id = $1 AND account_id = $2
      RETURNING id, account_id, type, name, configuration_encrypted, status, is_cold_default, last_verified_at, created_at`,
      [existing.id, req.account.id]
    );
    res.json({ verified: true, data: redactBackend(rows[0]) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
