const { mockDb } = require('../setup');
const health = require('../../src/services/healthService');

beforeEach(() => {
  mockDb.reset();
});

// Every COUNT query returns { n } so scalar() reads a number; the orphan run
// lookup and the two kv reads return empty by default.
function primeCounts(overrides = {}) {
  const defaults = {
    "status = 'done'": 42,          // healthy_assets
    "status = 'missing'": 2,        // missing_objects
    "status = 'corrupt'": 1,        // corrupt_objects
    "lifecycle_state = 'restoring'": 3, // pending_restores
    "lifecycle_state = 'archiving'": 4, // pending_archives
    "status = 'active' AND created_at": 5, // stuck_jobs
    "status = 'dead'": 6,           // dead_jobs
    "status = 'failed'": 7,         // failed_webhooks (outbox)
    'FROM files WHERE deleted_at IS NULL': 100, // total_files
    'FROM file_objects': 150,       // total_objects
  };
  const values = { ...defaults, ...overrides };
  for (const [needle, n] of Object.entries(values)) {
    mockDb.onQuery(needle, { rows: [{ n: String(n) }] });
  }
}

describe('computeHealth', () => {
  it('returns the expected metric shape and persists a snapshot', async () => {
    primeCounts();
    mockDb.onQuery("details ? 'orphan_objects'", { rows: [{ n: '9' }] });
    mockDb.onQuery('FROM lifecycle_kv WHERE key = $1', { rows: [] }); // last_backup
    mockDb.onQuery('FROM lifecycle_kv WHERE key = $1', { rows: [] }); // last_restore_test
    mockDb.onQuery('INSERT INTO health_snapshots', { rows: [{ id: 'snap-1', captured_at: new Date().toISOString() }] });

    const { metrics, snapshotId } = await health.computeHealth();

    expect(snapshotId).toBe('snap-1');
    expect(metrics).toEqual(expect.objectContaining({
      healthy_assets: 42,
      missing_objects: 2,
      corrupt_objects: 1,
      orphan_objects: 9,
      stuck_jobs: 5,
      dead_jobs: 6,
      failed_webhooks: 7,
      pending_restores: 3,
      pending_archives: 4,
      total_files: 100,
      total_objects: 150,
      last_backup_at: null,
      last_restore_test_at: null,
    }));
    // Snapshot row was written.
    const insert = mockDb.queryCalls.find((c) => c.text.includes('INSERT INTO health_snapshots'));
    expect(insert).toBeDefined();
    expect(insert.params[0]).toContain('healthy_assets');
  });

  it('does not write a snapshot when persist:false', async () => {
    primeCounts();
    mockDb.onQuery("details ? 'orphan_objects'", { rows: [] });
    mockDb.onQuery('FROM lifecycle_kv WHERE key = $1', { rows: [] });
    mockDb.onQuery('FROM lifecycle_kv WHERE key = $1', { rows: [] });

    const { snapshotId } = await health.computeHealth({ persist: false });

    expect(snapshotId).toBeNull();
    expect(mockDb.queryCalls.find((c) => c.text.includes('INSERT INTO health_snapshots'))).toBeUndefined();
  });

  it('surfaces ops timestamps written via the setters', async () => {
    primeCounts();
    mockDb.onQuery("details ? 'orphan_objects'", { rows: [] });
    mockDb.onQuery('FROM lifecycle_kv WHERE key = $1', { rows: [{ value: { at: '2026-08-01T00:00:00.000Z' } }] });
    mockDb.onQuery('FROM lifecycle_kv WHERE key = $1', { rows: [{ value: { at: '2026-08-10T00:00:00.000Z' } }] });
    mockDb.onQuery('INSERT INTO health_snapshots', { rows: [{ id: 'snap-2' }] });

    const { metrics } = await health.computeHealth();
    expect(metrics.last_backup_at).toBe('2026-08-01T00:00:00.000Z');
    expect(metrics.last_restore_test_at).toBe('2026-08-10T00:00:00.000Z');
  });
});

describe('setLastBackupAt / setLastRestoreTestAt', () => {
  it('upserts an ISO timestamp into lifecycle_kv', async () => {
    mockDb.onQuery('INSERT INTO lifecycle_kv', { rowCount: 1 });
    const iso = await health.setLastBackupAt(new Date('2026-08-12T12:00:00Z'));
    expect(iso).toBe('2026-08-12T12:00:00.000Z');
    const call = mockDb.queryCalls.find((c) => c.text.includes('INSERT INTO lifecycle_kv'));
    expect(call.params[0]).toBe('ops:last_backup_at');
    expect(call.params[1]).toContain('2026-08-12T12:00:00.000Z');
  });
});
