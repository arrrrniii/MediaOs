/**
 * Scheduled restoration self-test.
 *
 * Proves the storage round-trip still works end to end so the health
 * dashboard's "Last restore test" reflects reality rather than hope. Disabled
 * by default (RESTORE_TEST_ENABLED) so dev/CI stay quiet.
 *
 * When a cold backend is configured it writes a tiny probe to cold, copies it
 * back to hot with checksum verification (the real archive→restore path), then
 * deletes both copies. With no cold backend it falls back to a hot round-trip:
 * write probe → read back → verify checksum → delete. Either way it records the
 * outcome via healthService.setLastRestoreTestAt(), a structured log, and the
 * restore_tests_total / restore_test_last_success metrics. Everything it writes
 * is cleaned up; a failure is logged and surfaced, never thrown into the
 * scheduler.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const metrics = require('./metrics');

const RESTORE_TEST_ENABLED = process.env.RESTORE_TEST_ENABLED === 'true';
const PROBE_BYTES = parseInt(process.env.RESTORE_TEST_PROBE_BYTES || '1024', 10);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Run the self-test once.
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]  override RESTORE_TEST_ENABLED (for tests).
 * @param {object} [opts.storage]   override storageBackendService (for tests).
 * @param {object} [opts.health]    override healthService (for tests).
 * @returns {Promise<object>} { ok, skipped?, reason?, mode?, checksum?, error? }
 */
async function runRestoreSelftest(opts = {}) {
  const enabled = opts.enabled != null ? opts.enabled : RESTORE_TEST_ENABLED;
  if (!enabled) return { skipped: true, reason: 'disabled' };

  const storage = opts.storage || require('../services/storageBackendService');
  const health = opts.health || require('../services/healthService');
  const { copyVerified } = opts.transfer || require('../storage/transfer');

  const id = crypto.randomUUID();
  const probe = crypto.randomBytes(PROBE_BYTES);
  const checksum = sha256(probe);
  const contentType = 'application/octet-stream';

  const started = Date.now();
  try {
    const hotBackend = await storage.getDefaultBackend();
    const hotClient = storage.getBackendClient(hotBackend);
    const coldBackend = await storage.resolveColdBackend(null).catch(() => null);

    let mode;
    if (coldBackend && coldBackend.id !== hotBackend.id) {
      // Full archive→restore round-trip through the transfer helper.
      mode = 'cold_restore';
      const coldClient = storage.getBackendClient(coldBackend);
      const coldKey = `selftest/cold/${id}`;
      const hotKey = `selftest/hot/${id}`;
      await coldClient.putBuffer(coldKey, probe, contentType);
      const res = await copyVerified(coldClient, coldKey, hotClient, hotKey, {
        contentType, expectedChecksum: checksum,
      });
      if (res.checksum !== checksum) throw new Error('checksum mismatch after restore');
      await hotClient.removeObject(hotKey).catch(() => {});
      await coldClient.removeObject(coldKey).catch(() => {});
    } else {
      // No cold backend: hot round-trip verifies the default store.
      mode = 'hot_roundtrip';
      const hotKey = `selftest/hot/${id}`;
      await hotClient.putBuffer(hotKey, probe, contentType);
      const stream = await hotClient.getObject(hotKey);
      const got = await streamToBuffer(stream);
      const gotSum = sha256(got);
      await hotClient.removeObject(hotKey).catch(() => {});
      if (gotSum !== checksum) throw new Error('checksum mismatch on hot round-trip');
    }

    const at = await health.setLastRestoreTestAt(new Date());
    metrics.recordRestoreTest('pass');
    const duration_ms = Date.now() - started;
    logger.info('restore.selftest', { result: 'pass', mode, duration_ms, checksum, at });
    return { ok: true, mode, checksum, duration_ms, at };
  } catch (err) {
    metrics.recordRestoreTest('fail');
    logger.error('restore.selftest', { result: 'fail', error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { runRestoreSelftest, RESTORE_TEST_ENABLED };
