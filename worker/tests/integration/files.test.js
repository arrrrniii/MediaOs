const request = require('supertest');
const path = require('path');
const { createTestApp, mockDb, mockMinio, MASTER_KEY, testProject, testApiKey, testFile } = require('../setup');
const { sha256 } = require('../../src/utils/crypto');

let app;

const FULL_KEY = 'mv_live_test0123456789abcdef0123456789ab';

function setupAuthenticatedRequest() {
  const prefix = FULL_KEY.substring(0, 12);
  const hash = sha256(FULL_KEY);

  mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
    rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash }],
  });
  mockDb.onQuery("SELECT * FROM projects WHERE id", { rows: [testProject] });
  mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });
}

beforeEach(() => {
  mockDb.reset();
  mockMinio.reset();
  app = createTestApp();
});

describe('Files API', () => {
  // ── POST /api/v1/upload ────────────────────────────
  describe('POST /api/v1/upload', () => {
    it('should upload an image file and convert to WebP', async () => {
      setupAuthenticatedRequest();

      // Insert file record
      mockDb.onQuery('INSERT INTO files', {
        rows: [{
          ...testFile,
          storage_key: `${testProject.id}/test-abc123.webp`,
        }],
      });
      // Update project counters
      mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/upload')
        .set('X-API-Key', FULL_KEY)
        .attach('file', Buffer.from('fake-image-data'), {
          filename: 'test.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
      expect(res.body.type).toBe('image');
      expect(res.body.url).toContain('/f/');
      expect(res.body.urls).toBeDefined();
      expect(res.body.urls.original).toBeDefined();
      expect(res.body.status).toBe('done');
    });

    it('should upload with folder parameter', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('INSERT INTO files', {
        rows: [{ ...testFile, folder: 'avatars' }],
      });
      mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/upload?folder=avatars')
        .set('X-API-Key', FULL_KEY)
        .attach('file', Buffer.from('data'), {
          filename: 'avatar.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(200);
    });

    it('should sanitize folder path (prevent traversal)', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('INSERT INTO files', {
        rows: [{ ...testFile, folder: 'safe' }],
      });
      mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/upload?folder=../../etc/passwd')
        .set('X-API-Key', FULL_KEY)
        .attach('file', Buffer.from('data'), {
          filename: 'test.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(200);
      // The folder should have been sanitized (no .. or /)
      const insertCall = mockDb.queryCalls.find(c => c.text.includes('INSERT INTO files'));
      const folderParam = insertCall.params[4]; // folder is 5th param
      if (folderParam) {
        expect(folderParam).not.toContain('..');
      }
    });

    it('should return 400 with no file', async () => {
      setupAuthenticatedRequest();

      const res = await request(app)
        .post('/api/v1/upload')
        .set('X-API-Key', FULL_KEY);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NO_FILE');
    });

    it('should return 202 for video files (async processing)', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('INSERT INTO files', {
        rows: [{ ...testFile, type: 'video', status: 'processing' }],
      });

      const res = await request(app)
        .post('/api/v1/upload')
        .set('X-API-Key', FULL_KEY)
        .attach('file', Buffer.from('fake-video'), {
          filename: 'test.mov',
          contentType: 'video/quicktime',
        });

      expect(res.status).toBe(202);
      expect(res.body.status).toBe('processing');
    });

    it('should upload generic files as-is', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('INSERT INTO files', {
        rows: [{ ...testFile, type: 'file', mime_type: 'application/pdf' }],
      });
      mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/upload')
        .set('X-API-Key', FULL_KEY)
        .attach('file', Buffer.from('pdf-data'), {
          filename: 'doc.pdf',
          contentType: 'application/pdf',
        });

      expect(res.status).toBe(200);
    });

    it('should require upload scope', async () => {
      const readOnlyKey = 'mv_live_rdonly23456789abcdef0123456789ab';
      const prefix = readOnlyKey.substring(0, 12);
      const hash = sha256(readOnlyKey);

      mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
        rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash, scopes: ['read'] }],
      });
      mockDb.onQuery("SELECT * FROM projects WHERE id", { rows: [testProject] });
      mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/upload')
        .set('X-API-Key', readOnlyKey)
        .attach('file', Buffer.from('data'), {
          filename: 'test.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
    });
  });

  // ── POST /api/v1/upload/bulk ───────────────────────
  describe('POST /api/v1/upload/bulk', () => {
    it('should upload multiple files', async () => {
      setupAuthenticatedRequest();
      // Two inserts for two files
      mockDb.onQuery('INSERT INTO files', {
        rows: [{ ...testFile, id: 'file-1' }],
      });
      mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });
      mockDb.onQuery('INSERT INTO files', {
        rows: [{ ...testFile, id: 'file-2' }],
      });
      mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/upload/bulk')
        .set('X-API-Key', FULL_KEY)
        .attach('files', Buffer.from('data1'), { filename: 'a.png', contentType: 'image/png' })
        .attach('files', Buffer.from('data2'), { filename: 'b.png', contentType: 'image/png' });

      expect(res.status).toBe(200);
      expect(res.body.uploaded).toBe(2);
      expect(res.body.files).toHaveLength(2);
    });

    it('should return 400 with no files', async () => {
      setupAuthenticatedRequest();

      const res = await request(app)
        .post('/api/v1/upload/bulk')
        .set('X-API-Key', FULL_KEY);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NO_FILES');
    });
  });

  // ── GET /api/v1/files ──────────────────────────────
  describe('GET /api/v1/files', () => {
    it('should list files with pagination', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '1' }] });
      mockDb.onQuery('SELECT * FROM files', { rows: [testFile] });

      const res = await request(app)
        .get('/api/v1/files')
        .set('X-API-Key', FULL_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].url).toBeDefined();
    });

    it('should filter by folder', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '0' }] });
      mockDb.onQuery('SELECT * FROM files', { rows: [] });

      await request(app)
        .get('/api/v1/files?folder=avatars')
        .set('X-API-Key', FULL_KEY);

      const countCall = mockDb.queryCalls.find(c =>
        c.text.includes('COUNT') && c.text.includes('folder')
      );
      expect(countCall).toBeDefined();
    });

    it('should filter by type', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '0' }] });
      mockDb.onQuery('SELECT * FROM files', { rows: [] });

      await request(app)
        .get('/api/v1/files?type=image')
        .set('X-API-Key', FULL_KEY);

      const countCall = mockDb.queryCalls.find(c =>
        c.text.includes('COUNT') && c.params.includes('image')
      );
      expect(countCall).toBeDefined();
    });

    it('should search by filename', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '0' }] });
      mockDb.onQuery('SELECT * FROM files', { rows: [] });

      await request(app)
        .get('/api/v1/files?search=hero')
        .set('X-API-Key', FULL_KEY);

      const countCall = mockDb.queryCalls.find(c =>
        c.text.includes('ILIKE')
      );
      expect(countCall).toBeDefined();
    });
  });

  // ── GET /api/v1/files/:id ──────────────────────────
  describe('GET /api/v1/files/:id', () => {
    it('should return single file details', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('SELECT * FROM files WHERE id', { rows: [testFile] });

      const res = await request(app)
        .get(`/api/v1/files/${testFile.id}`)
        .set('X-API-Key', FULL_KEY);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(testFile.id);
      expect(res.body.url).toBeDefined();
    });

    it('should return 404 for non-existent file', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('SELECT * FROM files WHERE id', { rows: [] });

      const res = await request(app)
        .get('/api/v1/files/nonexistent')
        .set('X-API-Key', FULL_KEY);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  // ── DELETE /api/v1/files/:id ───────────────────────
  describe('DELETE /api/v1/files/:id', () => {
    it('should soft-delete file and clean up storage', async () => {
      setupAuthenticatedRequest();
      // Select file
      mockDb.onQuery('SELECT * FROM files WHERE id', { rows: [testFile] });
      // Soft delete
      mockDb.onQuery('UPDATE files SET deleted_at', { rowCount: 1 });
      // Decrement counters
      mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

      const res = await request(app)
        .delete(`/api/v1/files/${testFile.id}`)
        .set('X-API-Key', FULL_KEY);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      expect(res.body.freed_bytes).toBe(testFile.size);
    });

    it('should return 404 for non-existent file', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('SELECT * FROM files WHERE id', { rows: [] });

      const res = await request(app)
        .delete('/api/v1/files/nonexistent')
        .set('X-API-Key', FULL_KEY);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('should require delete scope', async () => {
      const readKey = 'mv_live_rdonly23456789abcdef0123456789ab';
      const prefix = readKey.substring(0, 12);
      const hash = sha256(readKey);

      mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
        rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash, scopes: ['read'] }],
      });
      mockDb.onQuery("SELECT * FROM projects WHERE id", { rows: [testProject] });
      mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });

      const res = await request(app)
        .delete(`/api/v1/files/${testFile.id}`)
        .set('X-API-Key', readKey);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
    });
  });

  // ── GET /api/v1/files/:id/signed-url ───────────────
  describe('GET /api/v1/files/:id/signed-url', () => {
    it('should generate a signed URL', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('SELECT f.storage_key, p.signing_secret', {
        rows: [{
          storage_key: testFile.storage_key,
          signing_secret: testProject.signing_secret,
        }],
      });

      const res = await request(app)
        .get(`/api/v1/files/${testFile.id}/signed-url`)
        .set('X-API-Key', FULL_KEY);

      expect(res.status).toBe(200);
      expect(res.body.url).toContain('token=');
      expect(res.body.url).toContain('expires=');
      expect(res.body.expires_at).toBeDefined();
    });

    it('should return 404 for non-existent file', async () => {
      setupAuthenticatedRequest();
      mockDb.onQuery('SELECT f.storage_key, p.signing_secret', { rows: [] });

      const res = await request(app)
        .get('/api/v1/files/nonexistent/signed-url')
        .set('X-API-Key', FULL_KEY);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });
});
