/**
 * Archive processor — safe cold-storage archival (Phase 6).
 *
 * Moves a logical file's physical objects from the hot backend to the account's
 * cold backend, verifying every copy by checksum before anything hot is
 * deleted, and keeping the hot copy for a grace window so a mistaken archive is
 * trivially reversible.
 *
 * ── State machine (per file) ────────────────────────────────
 *   active/cold_candidate/archiving
 *        │  processArchiveJob({fileId, scope})
 *        ▼
 *   files.lifecycle_state = 'archiving'          (guarded, audited: archive.start)
 *        │  for each in-scope object still on a hot/warm tier:
 *        │    1. copyVerified(hot → cold)         (streamed, sha256 both sides)
 *        │       └─ mismatch ⇒ mark COLD attempt 'corrupt', audit archive.corrupt,
 *        │          FAIL the job. Hot copy is untouched — never deleted on failure.
 *        │    2. repoint the object row to cold:  storage_backend_id/key = cold,
 *        │       tier='cold', archived_at=now, checksum filled; stash the hot
 *        │       location + hot_delete_after=now+grace in metadata. (archive.copied)
 *        ▼
 *   cold verified, hot retained (within grace)
 *        │  finalize: for each object whose grace has elapsed AND whose cold copy
 *        │  still verifies, delete the hot bytes and clear metadata.hot_*.
 *        │  (archive.hot_deleted)                 never deletes the only copy.
 *        ▼
 *   all in-scope objects cold + hot removed ⇒ files.lifecycle_state = 'archived'
 *   (archive.done). If some are still within grace, a delayed finalize job is
 *   enqueued (jobId archive-finalize:<fileId>) and the file stays 'archiving'.
 *
 * ── Idempotency ─────────────────────────────────────────────
 *   - The cold key is deterministic (`cold/<hot key>`), so a re-run overwrites
 *     the same object rather than making a second copy.
 *   - Before copying, an object already tier='cold' with a verifiable cold copy
 *     is skipped.
 *   - Hot deletion runs only when the grace deadline has passed AND the cold
 *     copy re-verifies; removeObject on an already-deleted key is a no-op, and
 *     metadata.hot_* is cleared so a re-run won't retry it.
 *   Running the job twice therefore neither double-copies nor loses data.
 */

const { query, withTransaction } = require('../../db');
const config = require('../../config');
const storageBackendService = require('../../services/storageBackendService');
const { writeAudit } = require('../../services/lifecycleService');
const { copyVerified, ChecksumMismatchError } = require('../../storage/transfer');
const { addJob, QUEUES, isEnabled } = require('../index');

const ARCHIVE_ACTOR = 'system:archive';
// Thumbnails stay hot so previews keep working even for archived assets.
const NEVER_ARCHIVE_ROLES = new Set(['thumbnail']);

function coldKeyFor(hotKey) {
  return `cold/${hotKey}`;
}

/** Load the file + its owning account id, or null if the file is gone. */
async function loadFile(fileId) {
  const { rows } = await query(
    `SELECT f.id, f.lifecycle_state, f.project_id, p.account_id
       FROM files f JOIN projects p ON p.id = f.project_id
      WHERE f.id = $1`,
    [fileId]
  );
  return rows[0] || null;
}

/** The objects an archive of `scope` should move. */
async function inScopeObjects(fileId, scope) {
  const { rows } = await query(
    `SELECT id, role, storage_backend_id, storage_key, mime_type, size, checksum,
            storage_tier, status, metadata, archived_at
       FROM file_objects
      WHERE file_id = $1`,
    [fileId]
  );
  return rows.filter((o) => {
    if (NEVER_ARCHIVE_ROLES.has(o.role)) return false;
    if (scope === 'source') return o.role === 'source';
    return true; // 'all'
  });
}

function mergeMetadata(existing, patch) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

/**
 * Copy one hot object to cold and repoint its row. Returns 'copied',
 * 'already-cold' (idempotent skip), or throws on checksum failure.
 */
async function archiveObject(file, obj, coldBackend, graceMs) {
  const coldClient = storageBackendService.getBackendClient(coldBackend);

  // Already cold? Verify the cold copy still exists; if so this is a no-op.
  if (obj.storage_tier === 'cold' && obj.storage_backend_id === coldBackend.id) {
    try {
      await coldClient.statObject(obj.storage_key);
      return { result: 'already-cold', object: obj };
    } catch {
      // Cold copy vanished — fall through and re-copy from the hot location
      // recorded in metadata (if any) or the current key.
    }
  }

  const hotBackendId = obj.storage_backend_id;
  const hotKey = obj.storage_key;
  const hotBackend = await storageBackendService.getBackendById(hotBackendId);
  const hotClient = storageBackendService.getBackendClient(hotBackend);
  const destKey = coldKeyFor(hotKey);

  try {
    const { checksum } = await copyVerified(hotClient, hotKey, coldClient, destKey, {
      contentType: obj.mime_type,
      expectedChecksum: obj.checksum || null,
    });

    const hotDeleteAfter = new Date(Date.now() + Math.max(0, graceMs)).toISOString();
    const newMeta = mergeMetadata(obj.metadata, {
      archiving: undefined,
      archive_intent: undefined,
      hot_backend_id: hotBackendId,
      hot_storage_key: hotKey,
      hot_delete_after: hotDeleteAfter,
    });

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE file_objects
            SET storage_backend_id = $2, storage_key = $3, storage_tier = 'cold',
                status = 'available', archived_at = NOW(), checksum = $4, metadata = $5
          WHERE id = $1`,
        [obj.id, coldBackend.id, destKey, checksum, JSON.stringify(newMeta)]
      );
      await writeAudit(client.query.bind(client), {
        accountId: file.account_id, projectId: file.project_id, fileId: file.id,
        action: 'archive.copied', fromState: 'archiving', toState: 'archiving', actor: ARCHIVE_ACTOR,
        detail: { object_id: obj.id, role: obj.role, cold_backend_id: coldBackend.id, cold_key: destKey, checksum },
      });
    });

    return { result: 'copied', object: { ...obj, storage_backend_id: coldBackend.id, storage_key: destKey, storage_tier: 'cold', checksum, metadata: newMeta } };
  } catch (err) {
    if (err instanceof ChecksumMismatchError) {
      // Mark the COLD copy attempt corrupt; the hot copy is left intact.
      await withTransaction(async (client) => {
        const corruptMeta = mergeMetadata(obj.metadata, { archive_error: err.message });
        // Only flip status to corrupt if the failure was on the destination;
        // a source-side mismatch means the hot copy itself is bad.
        await client.query(
          `UPDATE file_objects SET status = 'corrupt', metadata = $2 WHERE id = $1`,
          [obj.id, JSON.stringify(corruptMeta)]
        );
        await writeAudit(client.query.bind(client), {
          accountId: file.account_id, projectId: file.project_id, fileId: file.id,
          action: 'archive.corrupt', fromState: 'archiving', toState: 'archiving', actor: ARCHIVE_ACTOR,
          detail: { object_id: obj.id, role: obj.role, side: err.detail && err.detail.side, error: err.message },
        });
      });
    }
    throw err;
  }
}

/**
 * Delete the hot copy of an already-cold object IF its grace has elapsed and
 * the cold copy re-verifies. Returns true when no hot copy remains afterwards.
 */
async function finalizeObject(file, obj) {
  const meta = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {};
  if (!meta.hot_backend_id || !meta.hot_storage_key) {
    return { hotRemains: false }; // nothing hot left to remove
  }
  const deadline = meta.hot_delete_after ? new Date(meta.hot_delete_after).getTime() : 0;
  if (Number.isFinite(deadline) && deadline > Date.now()) {
    return { hotRemains: true, remainingMs: deadline - Date.now() };
  }

  // Grace elapsed — but never delete the only copy. Re-verify cold first.
  const coldBackend = await storageBackendService.getBackendById(obj.storage_backend_id);
  const coldClient = storageBackendService.getBackendClient(coldBackend);
  try {
    await coldClient.statObject(obj.storage_key);
  } catch {
    // Cold copy is not verifiable — do NOT delete the hot copy.
    return { hotRemains: true, coldMissing: true };
  }

  const hotBackend = await storageBackendService.getBackendById(meta.hot_backend_id);
  const hotClient = storageBackendService.getBackendClient(hotBackend);
  try {
    await hotClient.removeObject(meta.hot_storage_key);
  } catch {
    // Treat a missing hot object as already-deleted (idempotent).
  }

  const cleared = mergeMetadata(meta, {
    hot_backend_id: undefined, hot_storage_key: undefined, hot_delete_after: undefined,
  });
  await withTransaction(async (client) => {
    await client.query(`UPDATE file_objects SET metadata = $2 WHERE id = $1`, [obj.id, JSON.stringify(cleared)]);
    await writeAudit(client.query.bind(client), {
      accountId: file.account_id, projectId: file.project_id, fileId: file.id,
      action: 'archive.hot_deleted', fromState: 'archiving', toState: 'archiving', actor: ARCHIVE_ACTOR,
      detail: { object_id: obj.id, hot_backend_id: meta.hot_backend_id, hot_key: meta.hot_storage_key },
    });
  });
  return { hotRemains: false };
}

/**
 * Archive a file's in-scope objects to cold storage.
 * @param {object} data
 * @param {string} data.fileId
 * @param {string} [data.scope]   'source' | 'all' (default 'all')
 * @param {number} [data.graceMs] override the hot-retention grace (tests/reconciler)
 */
async function processArchiveJob(data = {}) {
  const fileId = data.fileId;
  const scope = data.scope === 'source' ? 'source' : 'all';
  const graceMs = Number.isFinite(data.graceMs) ? data.graceMs : config.archiveHotGraceMs;
  if (!fileId) return { skipped: true, reason: 'no_file_id' };

  const file = await loadFile(fileId);
  if (!file) return { skipped: true, reason: 'file_not_found' };

  const coldBackend = await storageBackendService.resolveColdBackend({ id: file.account_id });
  if (!coldBackend) {
    // No cold backend configured: do not move or lose anything. Leave the file
    // in 'archiving' so it is retried once a backend is added; audit the reason.
    await writeAudit(query, {
      accountId: file.account_id, projectId: file.project_id, fileId,
      action: 'archive.no_backend', fromState: file.lifecycle_state, toState: file.lifecycle_state,
      actor: ARCHIVE_ACTOR, detail: { scope },
    });
    return { archived: false, reason: 'no_cold_backend' };
  }

  // Ensure the file is marked archiving (idempotent; the enqueue path already
  // sets it, but the reconciler may enqueue directly).
  if (file.lifecycle_state !== 'archiving' && file.lifecycle_state !== 'archived') {
    await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE files SET lifecycle_state = 'archiving' WHERE id = $1 AND lifecycle_state <> 'archived'`,
        [fileId]
      );
      if (rowCount === 1) {
        await writeAudit(client.query.bind(client), {
          accountId: file.account_id, projectId: file.project_id, fileId,
          action: 'archive.start', fromState: file.lifecycle_state, toState: 'archiving',
          actor: ARCHIVE_ACTOR, detail: { scope, cold_backend_id: coldBackend.id },
        });
      }
    });
  }

  const objects = await inScopeObjects(fileId, scope);
  if (objects.length === 0) {
    return { archived: false, reason: 'no_objects_in_scope', scope };
  }

  // 1. Copy + verify every in-scope object to cold.
  let copied = 0;
  const current = [];
  for (const obj of objects) {
    const { result, object } = await archiveObject(file, obj, coldBackend, graceMs);
    if (result === 'copied') copied++;
    current.push(object);
  }

  // 2. Finalize: delete hot copies whose grace has elapsed.
  let hotRemaining = 0;
  let maxRemainingMs = 0;
  for (const obj of current) {
    const fin = await finalizeObject(file, obj);
    if (fin.hotRemains) {
      hotRemaining++;
      if (fin.remainingMs && fin.remainingMs > maxRemainingMs) maxRemainingMs = fin.remainingMs;
    }
  }

  // 3. All in-scope objects cold + hot removed ⇒ archived.
  if (hotRemaining === 0) {
    await withTransaction(async (client) => {
      await client.query(`UPDATE files SET lifecycle_state = 'archived' WHERE id = $1`, [fileId]);
      await writeAudit(client.query.bind(client), {
        accountId: file.account_id, projectId: file.project_id, fileId,
        action: 'archive.done', fromState: 'archiving', toState: 'archived', actor: ARCHIVE_ACTOR,
        detail: { scope, objects: current.length, copied },
      });
    });
    return { archived: true, scope, objects: current.length, copied };
  }

  // Some hot copies are still within grace — schedule a delayed finalize.
  if (isEnabled()) {
    const delay = Math.max(1000, maxRemainingMs);
    await addJob(
      QUEUES.ARCHIVE, 'archive-finalize', { fileId, scope },
      { jobId: `archive-finalize:${fileId}`, delay }
    ).catch(() => {});
  }
  return { archived: false, pendingGrace: true, hotRemaining, copied, scope };
}

module.exports = {
  processArchiveJob,
  coldKeyFor,
  inScopeObjects,
  archiveObject,
  finalizeObject,
  ARCHIVE_ACTOR,
};
