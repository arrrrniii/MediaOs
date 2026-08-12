const { mockDb } = require('../setup');
const fileObjectService = require('../../src/services/fileObjectService');

beforeEach(() => {
  mockDb.reset();
});

describe('fileObjectService', () => {
  describe('createObject', () => {
    it('inserts a file_objects row with all fields and returns it', async () => {
      const created = {
        id: 'obj-1', file_id: 'file-1', role: 'source', storage_key: 'proj/src.png',
      };
      mockDb.onQuery('INSERT INTO file_objects', { rows: [created] });

      const result = await fileObjectService.createObject({
        fileId: 'file-1',
        role: 'source',
        backendId: 'backend-1',
        storageKey: 'proj/src.png',
        mimeType: 'image/png',
        size: 1234,
        checksum: 'abc',
        tier: 'hot',
        status: 'available',
        width: 800,
        height: 600,
        metadata: { archive_after: '2026-01-01' },
      });

      expect(result).toEqual(created);
      const call = mockDb.queryCalls.find((c) => c.text.includes('INSERT INTO file_objects'));
      expect(call).toBeDefined();
      // role, backendId, storageKey, mimeType, size are params 2..6
      expect(call.params[1]).toBe('source');
      expect(call.params[2]).toBe('backend-1');
      expect(call.params[3]).toBe('proj/src.png');
      expect(call.params[5]).toBe(1234);
      expect(call.params[6]).toBe('abc');
      expect(call.params[7]).toBe('hot');
      expect(call.params[11]).toBe(JSON.stringify({ archive_after: '2026-01-01' }));
    });

    it('applies defaults for optional fields', async () => {
      mockDb.onQuery('INSERT INTO file_objects', { rows: [{ id: 'obj-2' }] });

      await fileObjectService.createObject({
        fileId: 'file-1', role: 'optimized', backendId: 'b', storageKey: 'k', mimeType: 'image/webp',
      });

      const call = mockDb.queryCalls.find((c) => c.text.includes('INSERT INTO file_objects'));
      expect(call.params[5]).toBe(0);       // size default
      expect(call.params[6]).toBeNull();    // checksum default
      expect(call.params[7]).toBe('hot');   // tier default
      expect(call.params[8]).toBe('available'); // status default
      expect(call.params[11]).toBe('{}');   // metadata default
    });
  });

  describe('listObjects', () => {
    it('returns all objects for a file ordered by created_at', async () => {
      const rows = [{ id: 'a', role: 'source' }, { id: 'b', role: 'optimized' }];
      mockDb.onQuery('FROM file_objects WHERE file_id = $1 ORDER BY created_at', { rows });

      const result = await fileObjectService.listObjects('file-1');
      expect(result).toEqual(rows);
      const call = mockDb.queryCalls.find((c) => c.text.includes('FROM file_objects WHERE file_id'));
      expect(call.params).toEqual(['file-1']);
    });
  });

  describe('getObjectByRole', () => {
    it('returns the first object of the given role', async () => {
      mockDb.onQuery('AND role = $2', { rows: [{ id: 'opt', role: 'optimized' }] });
      const result = await fileObjectService.getObjectByRole('file-1', 'optimized');
      expect(result).toEqual({ id: 'opt', role: 'optimized' });
      const call = mockDb.queryCalls.find((c) => c.text.includes('AND role = $2'));
      expect(call.params).toEqual(['file-1', 'optimized']);
    });

    it('returns null when no object of that role exists', async () => {
      mockDb.onQuery('AND role = $2', { rows: [] });
      const result = await fileObjectService.getObjectByRole('file-1', 'source');
      expect(result).toBeNull();
    });
  });

  describe('sumSizes', () => {
    it('sums the size of every physical copy', async () => {
      mockDb.onQuery('SELECT COALESCE(SUM(size), 0)', { rows: [{ total: '13579' }] });
      const total = await fileObjectService.sumSizes('file-1');
      expect(total).toBe(13579);
    });

    it('returns 0 when there are no objects', async () => {
      mockDb.onQuery('SELECT COALESCE(SUM(size), 0)', { rows: [{ total: 0 }] });
      const total = await fileObjectService.sumSizes('file-1');
      expect(total).toBe(0);
    });
  });

  describe('markStatus', () => {
    it('updates an object status', async () => {
      mockDb.onQuery('UPDATE file_objects SET status', { rowCount: 1 });
      await fileObjectService.markStatus('obj-1', 'corrupt');
      const call = mockDb.queryCalls.find((c) => c.text.includes('UPDATE file_objects SET status'));
      expect(call.params).toEqual(['corrupt', 'obj-1']);
    });
  });
});
