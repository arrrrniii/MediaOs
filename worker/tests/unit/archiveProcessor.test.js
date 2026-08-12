const { mockDb } = require('../setup');

// Control the storage seam and the verified-transfer helper. ChecksumMismatchError
// stays the REAL class so archive.js's instanceof check works.
jest.mock('../../src/services/storageBackendService', () => ({
  resolveColdBackend: jest.fn(),
  getBackendById: jest.fn(),
  getBackendClient: jest.fn(),
}));
jest.mock('../../src/storage/transfer', () => {
  const actual = jest.requireActual('../../src/storage/transfer');
  return { ...actual, copyVerified: jest.fn() };
});

const storageBackendService = require('../../src/services/storageBackendService');
const transfer = require('../../src/storage/transfer');
const queue = require('../../src/queue');
const archive = require('../../src/queue/processors/archive');

const COLD_BACKEND = { id: 'cold-b', type: 'minio', name: 'Cold', configuration_encrypted: 'enc', status: 'active' };
const HOT_BACKEND = { id: 'hot-b', type: 'minio', name: 'Hot', configuration_encrypted: null, status: 'active' };

function makeClient(overrides = {}) {
  return {
    putBuffer: jest.fn(async () => {}),
    putFile: jest.fn(async () => {}),
    getObject: jest.fn(async () => {}),
    statObject: jest.fn(async () => ({ size: 100, etag: 'e' })),
    removeObject: jest.fn(async () => {}),
    ...overrides,
  };
}

function auditCall(action) {
  return mockDb.queryCalls.find(
    (c) => c.text.includes('INSERT INTO lifecycle_audit') && c.params[3] === action
  );
}
function findCall(sub) {
  return mockDb.queryCalls.find((c) => c.text.includes(sub));
}

function primeFile(state = 'cold_candidate') {
  mockDb.onQuery('FROM files f JOIN projects p ON p.id = f.project_id', {
    rows: [{ id: 'f1', lifecycle_state: state, project_id: 'proj-1', account_id: 'acc-1' }],
  });
  mockDb.onQuery("SET lifecycle_state = 'archiving'", { rowCount: 1 });
}

function primeObjects(objects) {
  mockDb.onQuery('FROM file_objects', { rows: objects });
}

beforeEach(() => {
  mockDb.reset();
  storageBackendService.resolveColdBackend.mockReset();
  storageBackendService.getBackendById.mockReset();
  storageBackendService.getBackendClient.mockReset();
  transfer.copyVerified.mockReset();
  queue.addJob.mockClear();
  storageBackendService.resolveColdBackend.mockResolvedValue(COLD_BACKEND);
  storageBackendService.getBackendById.mockResolvedValue(HOT_BACKEND);
});

describe('processArchiveJob', () => {
  it('copies source→cold, verifies, deletes hot after grace=0, and marks archived', async () => {
    primeFile('cold_candidate');
    primeObjects([
      { id: 'o1', role: 'source', storage_backend_id: 'hot-b', storage_key: 'proj-1/src.png',
        mime_type: 'image/png', size: 100, checksum: 'sum1', storage_tier: 'hot', status: 'available', metadata: {} },
    ]);
    const coldClient = makeClient();
    const hotClient = makeClient();
    storageBackendService.getBackendClient.mockImplementation((b) => (b.id === 'cold-b' ? coldClient : hotClient));
    transfer.copyVerified.mockResolvedValue({ size: 100, checksum: 'sum1' });

    const result = await archive.processArchiveJob({ fileId: 'f1', scope: 'source', graceMs: 0 });

    expect(result).toMatchObject({ archived: true, scope: 'source', copied: 1 });
    // Copied hot→cold under the tiered key.
    expect(transfer.copyVerified).toHaveBeenCalledWith(
      hotClient, 'proj-1/src.png', coldClient, 'cold/proj-1/src.png', expect.objectContaining({ expectedChecksum: 'sum1' })
    );
    // Hot copy deleted (grace elapsed) after cold verified.
    expect(hotClient.removeObject).toHaveBeenCalledWith('proj-1/src.png');
    // State machine audit trail.
    expect(auditCall('archive.start')).toBeDefined();
    expect(auditCall('archive.copied')).toBeDefined();
    expect(auditCall('archive.hot_deleted')).toBeDefined();
    expect(auditCall('archive.done')).toBeDefined();
    expect(findCall("SET lifecycle_state = 'archived'")).toBeDefined();
  });

  it('keeps the hot copy within the grace window and schedules a finalize job', async () => {
    primeFile('cold_candidate');
    primeObjects([
      { id: 'o1', role: 'source', storage_backend_id: 'hot-b', storage_key: 'proj-1/src.png',
        mime_type: 'image/png', size: 100, checksum: 'sum1', storage_tier: 'hot', status: 'available', metadata: {} },
    ]);
    const coldClient = makeClient();
    const hotClient = makeClient();
    storageBackendService.getBackendClient.mockImplementation((b) => (b.id === 'cold-b' ? coldClient : hotClient));
    transfer.copyVerified.mockResolvedValue({ size: 100, checksum: 'sum1' });

    const result = await archive.processArchiveJob({ fileId: 'f1', scope: 'source', graceMs: 60_000 });

    expect(result).toMatchObject({ archived: false, pendingGrace: true });
    // Cold copy verified, but hot NOT yet deleted (still within grace).
    expect(hotClient.removeObject).not.toHaveBeenCalled();
    expect(auditCall('archive.hot_deleted')).toBeUndefined();
    expect(auditCall('archive.done')).toBeUndefined();
    // A delayed finalize was enqueued.
    expect(queue.addJob).toHaveBeenCalledWith(
      'archive', 'archive-finalize', expect.objectContaining({ fileId: 'f1' }),
      expect.objectContaining({ jobId: 'archive-finalize:f1' })
    );
  });

  it('aborts and marks the object corrupt on a checksum mismatch, never deleting hot', async () => {
    primeFile('cold_candidate');
    primeObjects([
      { id: 'o1', role: 'source', storage_backend_id: 'hot-b', storage_key: 'proj-1/src.png',
        mime_type: 'image/png', size: 100, checksum: 'sum1', storage_tier: 'hot', status: 'available', metadata: {} },
    ]);
    const coldClient = makeClient();
    const hotClient = makeClient();
    storageBackendService.getBackendClient.mockImplementation((b) => (b.id === 'cold-b' ? coldClient : hotClient));
    transfer.copyVerified.mockRejectedValue(
      new transfer.ChecksumMismatchError('destination checksum mismatch', { side: 'destination' })
    );

    await expect(archive.processArchiveJob({ fileId: 'f1', scope: 'source', graceMs: 0 }))
      .rejects.toThrow(/checksum mismatch/);

    // Object marked corrupt; hot copy left intact (never deleted).
    expect(findCall("SET status = 'corrupt'")).toBeDefined();
    expect(auditCall('archive.corrupt')).toBeDefined();
    expect(hotClient.removeObject).not.toHaveBeenCalled();
    expect(findCall("SET lifecycle_state = 'archived'")).toBeUndefined();
  });

  it('is idempotent: an already-cold object is not re-copied', async () => {
    primeFile('archiving');
    primeObjects([
      { id: 'o1', role: 'source', storage_backend_id: 'cold-b', storage_key: 'cold/proj-1/src.png',
        mime_type: 'image/png', size: 100, checksum: 'sum1', storage_tier: 'cold', status: 'available',
        metadata: {} }, // no hot copy left
    ]);
    const coldClient = makeClient();
    storageBackendService.getBackendClient.mockReturnValue(coldClient);

    const result = await archive.processArchiveJob({ fileId: 'f1', scope: 'source', graceMs: 0 });

    expect(transfer.copyVerified).not.toHaveBeenCalled();
    expect(result).toMatchObject({ archived: true });
    expect(coldClient.statObject).toHaveBeenCalledWith('cold/proj-1/src.png');
  });

  it('no-ops safely when no cold backend is configured (never loses data)', async () => {
    storageBackendService.resolveColdBackend.mockResolvedValue(null);
    primeFile('cold_candidate');

    const result = await archive.processArchiveJob({ fileId: 'f1', scope: 'all', graceMs: 0 });

    expect(result).toEqual({ archived: false, reason: 'no_cold_backend' });
    expect(transfer.copyVerified).not.toHaveBeenCalled();
    expect(auditCall('archive.no_backend')).toBeDefined();
  });

  it("archive_all skips thumbnails so previews keep working", async () => {
    primeFile('cold_candidate');
    primeObjects([
      { id: 'o1', role: 'optimized', storage_backend_id: 'hot-b', storage_key: 'proj-1/o.webp',
        mime_type: 'image/webp', size: 50, checksum: 's1', storage_tier: 'hot', status: 'available', metadata: {} },
      { id: 'o2', role: 'thumbnail', storage_backend_id: 'hot-b', storage_key: 'proj-1/t.webp',
        mime_type: 'image/webp', size: 10, checksum: 's2', storage_tier: 'hot', status: 'available', metadata: {} },
    ]);
    const coldClient = makeClient();
    const hotClient = makeClient();
    storageBackendService.getBackendClient.mockImplementation((b) => (b.id === 'cold-b' ? coldClient : hotClient));
    transfer.copyVerified.mockResolvedValue({ size: 50, checksum: 's1' });

    await archive.processArchiveJob({ fileId: 'f1', scope: 'all', graceMs: 0 });

    // Only the optimized object was copied; the thumbnail was left hot.
    expect(transfer.copyVerified).toHaveBeenCalledTimes(1);
    expect(transfer.copyVerified).toHaveBeenCalledWith(
      hotClient, 'proj-1/o.webp', coldClient, 'cold/proj-1/o.webp', expect.anything()
    );
  });
});
