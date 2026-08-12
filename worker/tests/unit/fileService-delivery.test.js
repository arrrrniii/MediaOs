const { mockDb, mockMinio, testProject } = require('../setup');
const fileService = require('../../src/services/fileService');

const project = { ...testProject };

beforeEach(() => {
  mockDb.reset();
  mockMinio.reset();
});

describe('content dedup', () => {
  it('reuses an existing file’s bytes and sets dedup_of, storing nothing', async () => {
    // A live file in the project already holds these source bytes.
    mockDb.onQuery('AND content_hash = $2', {
      rows: [{
        id: 'orig-id', project_id: project.id, storage_key: `${project.id}/orig.webp`,
        thumbnail_key: null, type: 'image', mime_type: 'image/webp', size: 5000,
        width: 800, height: 600, checksum: 'srchash', content_hash: 'srchash',
        access: 'public', dedup_of: null,
      }],
    });
    // createDedupedFile INSERT.
    mockDb.onQuery('INSERT INTO files', {
      rows: [{
        id: 'dup-id', project_id: project.id, storage_key: `${project.id}/orig.webp`,
        filename: 'orig.webp', type: 'image', mime_type: 'image/webp', size: 5000,
        access: 'public', status: 'done', created_at: new Date().toISOString(),
      }],
    });
    mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

    const result = await fileService.uploadFile(
      { buffer: Buffer.from('identical-bytes'), originalname: 'copy.png' },
      project,
      {}
    );

    expect(result.deduped).toBe(true);
    expect(result.dedup_of).toBe('orig-id');
    expect(result.id).toBe('dup-id');
    // No bytes were stored — dedup reuses the original's objects.
    expect(mockMinio.putBufferCalls.length).toBe(0);
  });
});

describe('idempotency', () => {
  it('returns the existing file for a repeated idempotency key', async () => {
    mockDb.onQuery('FROM direct_uploads', { rows: [{ file_id: 'existing-file' }] });
    mockDb.onQuery('SELECT * FROM files WHERE id = $1 AND project_id', {
      rows: [{ id: 'existing-file', project_id: project.id, storage_key: `${project.id}/x.webp`, type: 'image', mime_type: 'image/webp', size: 10, access: 'public', status: 'done', created_at: new Date().toISOString() }],
    });

    const result = await fileService.uploadFile(
      { buffer: Buffer.from('whatever'), originalname: 'x.png' },
      project,
      { idempotencyKey: 'key-123' }
    );

    expect(result.idempotent_replay).toBe(true);
    expect(result.id).toBe('existing-file');
    expect(mockMinio.putBufferCalls.length).toBe(0);
  });
});

describe('reference-safe delete', () => {
  it('keeps physical bytes while another file still references the canonical', async () => {
    mockDb.onQuery('SELECT * FROM files WHERE id = $1 AND project_id', {
      rows: [{ id: 'orig-id', project_id: project.id, dedup_of: null, storage_key: `${project.id}/orig.webp`, thumbnail_key: null, size: 5000, filename: 'orig.webp', type: 'image' }],
    });
    mockDb.onQuery('UPDATE files SET deleted_at', { rowCount: 1 });
    // A dependent still references the canonical → liveRefs = 1.
    mockDb.onQuery('SELECT COUNT(*)::int AS n FROM files', { rows: [{ n: 1 }] });
    mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

    const result = await fileService.deleteFile('orig-id', { id: project.id });
    expect(result.deleted).toBe(true);
    // Bytes must NOT be removed while another file references them.
    expect(mockMinio.removedKeys.length).toBe(0);
  });

  it('removes physical bytes once the last reference is gone', async () => {
    mockDb.onQuery('SELECT * FROM files WHERE id = $1 AND project_id', {
      rows: [{ id: 'orig-id', project_id: project.id, dedup_of: null, storage_key: `${project.id}/orig.webp`, thumbnail_key: null, size: 5000, filename: 'orig.webp', type: 'image' }],
    });
    mockDb.onQuery('UPDATE files SET deleted_at', { rowCount: 1 });
    mockDb.onQuery('SELECT COUNT(*)::int AS n FROM files', { rows: [{ n: 0 }] });
    mockDb.onQuery('FROM file_objects WHERE file_id', {
      rows: [{ storage_key: `${project.id}/orig.webp`, size: 5000, storage_backend_id: null, role: 'optimized' }],
    });
    mockDb.onQuery('SELECT storage_key FROM transform_cache', { rows: [] });
    mockDb.onQuery('UPDATE files SET cache_version', { rows: [{ cache_version: 2 }] });
    mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

    const result = await fileService.deleteFile('orig-id', { id: project.id });
    expect(result.deleted).toBe(true);
    expect(mockMinio.removedKeys).toContain(`${project.id}/orig.webp`);
  });
});

describe('srcset', () => {
  it('builds a public srcset with the default widths', async () => {
    mockDb.onQuery('SELECT * FROM files WHERE id = $1 AND project_id', {
      rows: [{ id: 'f1', project_id: project.id, type: 'image', storage_key: `${project.id}/img.webp`, access: 'public' }],
    });
    const result = await fileService.getSrcset('f1', project, {});
    expect(result.widths).toEqual([320, 640, 960, 1280, 1600]);
    expect(result.urls.length).toBe(5);
    expect(result.srcset).toContain('320w');
    expect(result.srcset).toContain('/img/fit/320/0/f/');
    expect(result.sizes).toBe('100vw');
  });

  it('signs each srcset candidate for a private file', async () => {
    mockDb.onQuery('SELECT * FROM files WHERE id = $1 AND project_id', {
      rows: [{ id: 'f1', project_id: project.id, type: 'image', storage_key: `${project.id}/img.webp`, access: 'private' }],
    });
    const result = await fileService.getSrcset('f1', { ...project }, { widths: [640] });
    expect(result.urls[0].url).toContain('token=');
    expect(result.urls[0].url).toContain('expires=');
  });

  it('rejects srcset for a non-image', async () => {
    mockDb.onQuery('SELECT * FROM files WHERE id = $1 AND project_id', {
      rows: [{ id: 'f1', project_id: project.id, type: 'file', storage_key: `${project.id}/doc.pdf`, access: 'public' }],
    });
    await expect(fileService.getSrcset('f1', project, {})).rejects.toThrow(/image/i);
  });
});
