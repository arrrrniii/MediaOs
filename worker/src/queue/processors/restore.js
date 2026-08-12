/**
 * Restore processor — bring an archived file back to hot storage (Phase 6).
 *
 * The inverse of the archiver: copies each cold object back to the hot
 * (default) backend, verifies it by checksum + size, repoints the object row
 * to hot, and only THEN removes the cold copy — so the file is never left
 * without a verifiable copy. Marks the file active again, stamps
 * last_accessed_at, raises an "asset automatically restored" notification, and
 * audits every step.
 *
 * Idempotency: an object already on the hot/default backend with a verifiable
 * copy is skipped; the hot key is deterministic (the object's original hot key,
 * recorded in metadata.hot_storage_key or derived by stripping the `cold/`
 * prefix), so a re-run overwrites rather than duplicates; the cold copy is only
 * deleted after the hot copy verifies, so a second run cannot lose data.
 */

const { query, withTransaction } = require('../../db');
const storageBackendService = require('../../services/storageBackendService');
const { writeAudit } = require('../../services/lifecycleService');
const { copyVerified } = require('../../storage/transfer');

const RESTORE_ACTOR = 'system:restore';

/** The hot key an archived object should be restored to. */
function hotKeyFor(obj) {
  const meta = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {};
  if (meta.hot_storage_key) return meta.hot_storage_key;
  if (typeof obj.storage_key === 'string' && obj.storage_key.startsWith('cold/')) {
    return obj.storage_key.slice('cold/'.length);
  }
  return obj.storage_key;
}

async function loadFile(fileId) {
  const { rows } = await query(
    `SELECT f.id, f.lifecycle_state, f.project_id, p.account_id
       FROM files f JOIN projects p ON p.id = f.project_id
      WHERE f.id = $1`,
    [fileId]
  );
  return rows[0] || null;
}

/** Objects currently in a cold/archive tier (or flagged archived). */
async function archivedObjects(fileId) {
  const { rows } = await query(
    `SELECT id, role, storage_backend_id, storage_key, mime_type, size, checksum,
            storage_tier, status, metadata, archived_at
       FROM file_objects
      WHERE file_id = $1
        AND (storage_tier IN ('cold', 'archive') OR archived_at IS NOT NULL)`,
    [fileId]
  );
  return rows;
}

function mergeMetadata(existing, patch) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

/** Restore one cold object to hot storage. Returns 'restored' or 'already-hot'. */
async function restoreObject(file, obj, hotBackend) {
  const hotClient = storageBackendService.getBackendClient(hotBackend);
  const hotKey = hotKeyFor(obj);

  // Already hot on the target backend with a verifiable copy? Skip.
  if (obj.storage_tier === 'hot' && obj.storage_backend_id === hotBackend.id) {
    try {
      await hotClient.statObject(obj.storage_key);
      return 'already-hot';
    } catch {
      // fall through and re-copy
    }
  }

  const coldBackend = await storageBackendService.getBackendById(obj.storage_backend_id);
  const coldClient = storageBackendService.getBackendClient(coldBackend);

  const { checksum } = await copyVerified(coldClient, obj.storage_key, hotClient, hotKey, {
    contentType: obj.mime_type,
    expectedChecksum: obj.checksum || null,
  });

  const coldBackendId = obj.storage_backend_id;
  const coldKey = obj.storage_key;
  const newMeta = mergeMetadata(obj.metadata, {
    hot_backend_id: undefined, hot_storage_key: undefined, hot_delete_after: undefined,
    archive_error: undefined,
  });

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE file_objects
          SET storage_backend_id = $2, storage_key = $3, storage_tier = 'hot',
              status = 'available', archived_at = NULL, checksum = $4, metadata = $5
        WHERE id = $1`,
      [obj.id, hotBackend.id, hotKey, checksum, JSON.stringify(newMeta)]
    );
    await writeAudit(client.query.bind(client), {
      accountId: file.account_id, projectId: file.project_id, fileId: file.id,
      action: 'restore.copied', fromState: 'restoring', toState: 'restoring', actor: RESTORE_ACTOR,
      detail: { object_id: obj.id, role: obj.role, hot_backend_id: hotBackend.id, hot_key: hotKey, checksum },
    });
  });

  // Hot copy verified — now safe to drop the cold copy (never before).
  try {
    await coldClient.removeObject(coldKey);
  } catch {
    // idempotent: a missing cold object is fine
  }

  return 'restored';
}

/**
 * Restore an archived file to hot storage.
 * @param {object} data
 * @param {string} data.fileId
 */
async function processRestoreJob(data = {}) {
  const fileId = data.fileId;
  if (!fileId) return { skipped: true, reason: 'no_file_id' };

  const file = await loadFile(fileId);
  if (!file) return { skipped: true, reason: 'file_not_found' };

  const hotBackend = await storageBackendService.getDefaultBackend();
  const objects = await archivedObjects(fileId);

  let restored = 0;
  for (const obj of objects) {
    const r = await restoreObject(file, obj, hotBackend);
    if (r === 'restored') restored++;
  }

  // Mark the file active again + record access, then notify + audit.
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE files SET lifecycle_state = 'active', last_accessed_at = NOW() WHERE id = $1`,
      [fileId]
    );
    await writeAudit(client.query.bind(client), {
      accountId: file.account_id, projectId: file.project_id, fileId,
      action: 'restore.done', fromState: file.lifecycle_state, toState: 'active', actor: RESTORE_ACTOR,
      detail: { objects: objects.length, restored },
    });
  });

  // Best-effort notification (asset automatically restored).
  try {
    await query(
      `INSERT INTO lifecycle_notifications (account_id, project_id, type, title, body, data)
       VALUES ($1, $2, 'lifecycle_restore', $3, $4, $5)`,
      [
        file.account_id, file.project_id,
        'Asset automatically restored',
        'An archived asset was restored to hot storage and is available again.',
        JSON.stringify({ file_id: fileId, restored_objects: restored }),
      ]
    );
  } catch {
    // a notification failure must not fail the restore
  }

  return { restored: true, objects: objects.length, copied: restored };
}

module.exports = {
  processRestoreJob,
  restoreObject,
  archivedObjects,
  hotKeyFor,
  RESTORE_ACTOR,
};
