const { mockDb } = require('../setup');

jest.mock('../../src/services/storageBackendService', () => ({
  getDefaultBackend: jest.fn(),
  getBackendById: jest.fn(),
  getBackendClient: jest.fn(),
}));
jest.mock('../../src/storage/transfer', () => {
  const actual = jest.requireActual('../../src/storage/transfer');
  return { ...actual, copyVerified: jest.fn() };
});

const storageBackendService = require('../../src/services/storageBackendService');
const transfer = require('../../src/storage/transfer');
const restore = require('../../src/queue/processors/restore');

const HOT_BACKEND = { id: 'hot-b', type: 'minio', configuration_encrypted: null, status: 'active' };
const COLD_BACKEND = { id: 'cold-b', type: 'minio', configuration_encrypted: 'enc', status: 'active' };

function makeClient(overrides = {}) {
  return {
    putFile: jest.fn(async () => {}),
    getObject: jest.fn(async () => {}),
    statObject: jest.fn(async () => ({ size: 100 })),
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

function primeFile(state = 'archived') {
  mockDb.onQuery('FROM files f JOIN projects p ON p.id = f.project_id', {
    rows: [{ id: 'f1', lifecycle_state: state, project_id: 'proj-1', account_id: 'acc-1' }],
  });
}
function primeArchivedObjects(objects) {
  mockDb.onQuery('FROM file_objects', { rows: objects });
}

beforeEach(() => {
  mockDb.reset();
  storageBackendService.getDefaultBackend.mockReset();
  storageBackendService.getBackendById.mockReset();
  storageBackendService.getBackendClient.mockReset();
  transfer.copyVerified.mockReset();
  storageBackendService.getDefaultBackend.mockResolvedValue(HOT_BACKEND);
  storageBackendService.getBackendById.mockResolvedValue(COLD_BACKEND);
});

describe('processRestoreJob', () => {
  it('copies cold→hot, verifies, marks the file active, and notifies', async () => {
    primeFile('archived');
    primeArchivedObjects([
      { id: 'o1', role: 'source', storage_backend_id: 'cold-b', storage_key: 'cold/proj-1/src.png',
        mime_type: 'image/png', size: 100, checksum: 'sum1', storage_tier: 'cold', status: 'available',
        metadata: { hot_backend_id: 'hot-b', hot_storage_key: 'proj-1/src.png' }, archived_at: new Date().toISOString() },
    ]);
    const hotClient = makeClient();
    const coldClient = makeClient();
    storageBackendService.getBackendClient.mockImplementation((b) => (b.id === 'hot-b' ? hotClient : coldClient));
    transfer.copyVerified.mockResolvedValue({ size: 100, checksum: 'sum1' });

    const result = await restore.processRestoreJob({ fileId: 'f1' });

    expect(result).toMatchObject({ restored: true, copied: 1 });
    expect(transfer.copyVerified).toHaveBeenCalledWith(
      coldClient, 'cold/proj-1/src.png', hotClient, 'proj-1/src.png', expect.objectContaining({ expectedChecksum: 'sum1' })
    );
    // Object repointed to hot; file marked active; cold copy dropped after hot verified.
    expect(findCall("storage_tier = 'hot'")).toBeDefined();
    expect(findCall("SET lifecycle_state = 'active', last_accessed_at = NOW()")).toBeDefined();
    expect(coldClient.removeObject).toHaveBeenCalledWith('cold/proj-1/src.png');
    expect(auditCall('restore.done')).toBeDefined();
    // "asset automatically restored" notification.
    const notif = findCall('INSERT INTO lifecycle_notifications');
    expect(notif).toBeDefined();
    expect(notif.params[2]).toMatch(/restored/i);
  });

  it('is idempotent: an already-hot object is not re-copied', async () => {
    primeFile('archived');
    primeArchivedObjects([
      { id: 'o1', role: 'source', storage_backend_id: 'hot-b', storage_key: 'proj-1/src.png',
        mime_type: 'image/png', size: 100, checksum: 'sum1', storage_tier: 'hot', status: 'available',
        metadata: {}, archived_at: null },
    ]);
    const hotClient = makeClient();
    storageBackendService.getBackendClient.mockReturnValue(hotClient);

    // archivedObjects only returns cold/archived rows, so an already-hot object
    // won't even be selected — simulate that by returning none.
    mockDb.reset();
    primeFile('archived');
    primeArchivedObjects([]);

    const result = await restore.processRestoreJob({ fileId: 'f1' });

    expect(transfer.copyVerified).not.toHaveBeenCalled();
    expect(result).toMatchObject({ restored: true, objects: 0 });
    // Still flips the file active (idempotent finalization).
    expect(findCall("SET lifecycle_state = 'active'")).toBeDefined();
  });
});
