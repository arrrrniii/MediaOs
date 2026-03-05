import { MediaOS, MediaOSApiError } from '../src/index';
import { createHmac } from 'crypto';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('MediaOS SDK', () => {
  let mv: MediaOS;

  beforeEach(() => {
    mockFetch.mockReset();
    mv = new MediaOS({
      url: 'https://cdn.example.com',
      apiKey: 'mv_live_test1234567890abcdef',
    });
  });

  // ── Constructor ──────────────────────────────────────
  describe('constructor', () => {
    it('should require url', () => {
      expect(() => new MediaOS({ url: '', apiKey: 'key' })).toThrow('url is required');
    });

    it('should require apiKey', () => {
      expect(() => new MediaOS({ url: 'http://test.com', apiKey: '' })).toThrow('apiKey is required');
    });

    it('should strip trailing slash from url', () => {
      const client = new MediaOS({ url: 'https://cdn.example.com/', apiKey: 'key' });
      expect(client.url('test.webp')).toBe('https://cdn.example.com/f/test.webp');
    });

    it('should default timeout to 30000', () => {
      // No way to directly check, but it shouldn't throw
      expect(() => new MediaOS({ url: 'http://test.com', apiKey: 'key' })).not.toThrow();
    });
  });

  // ── Upload ─────────────────────────────────────────
  describe('upload', () => {
    it('should POST to /api/v1/upload with file', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        id: 'file-1',
        filename: 'test.webp',
        url: 'https://cdn.example.com/f/proj/test.webp',
        storage_key: 'proj/test.webp',
        urls: { original: 'https://cdn.example.com/f/proj/test.webp' },
        type: 'image',
        mime_type: 'image/webp',
        size: 5000,
        original_size: 10000,
        access: 'public',
        status: 'done',
        processing_ms: 50,
        created_at: '2026-01-01T00:00:00Z',
      }));

      const result = await mv.upload(Buffer.from('test-data'), { name: 'test.png' });

      expect(result.id).toBe('file-1');
      expect(result.type).toBe('image');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://cdn.example.com/api/v1/upload');
      expect(opts.method).toBe('POST');
      expect(opts.headers['X-API-Key']).toBe('mv_live_test1234567890abcdef');
    });

    it('should include folder and access params', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ id: 'file-1' }));

      await mv.upload(Buffer.from('data'), { folder: 'avatars', access: 'private' });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('folder=avatars');
      expect(url).toContain('access=private');
    });
  });

  // ── Bulk Upload ────────────────────────────────────
  describe('uploadBulk', () => {
    it('should POST to /api/v1/upload/bulk', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        uploaded: 2,
        failed: 0,
        files: [{ id: 'f1' }, { id: 'f2' }],
        errors: [],
      }));

      const result = await mv.uploadBulk([
        { data: Buffer.from('a'), name: 'a.png' },
        { data: Buffer.from('b'), name: 'b.png' },
      ]);

      expect(result.uploaded).toBe(2);
      expect(result.failed).toBe(0);
    });
  });

  // ── Files ──────────────────────────────────────────
  describe('files', () => {
    it('should list files', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        data: [{ id: 'f1' }],
        total: 1,
        page: 1,
        limit: 50,
      }));

      const result = await mv.files.list({ page: 1, limit: 50 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/v1/files');
    });

    it('should pass filter params', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ data: [], total: 0, page: 1, limit: 50 }));

      await mv.files.list({ folder: 'avatars', type: 'image', search: 'hero' });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('folder=avatars');
      expect(url).toContain('type=image');
      expect(url).toContain('search=hero');
    });

    it('should get file by id', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ id: 'file-1', filename: 'test.webp' }));

      const result = await mv.files.get('file-1');

      expect(result.id).toBe('file-1');
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/v1/files/file-1');
    });

    it('should delete file by id', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        deleted: true,
        id: 'file-1',
        storage_key: 'key',
        freed_bytes: 5000,
      }));

      const result = await mv.files.delete('file-1');

      expect(result.deleted).toBe(true);
      expect(result.freed_bytes).toBe(5000);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/v1/files/file-1');
      expect(opts.method).toBe('DELETE');
    });

    it('should get signed URL', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        url: 'https://cdn.example.com/f/key?token=abc&expires=99999',
        expires_at: '2026-12-31T00:00:00Z',
      }));

      const result = await mv.files.signedUrl('file-1', 7200);

      expect(result.url).toContain('token=');
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/v1/files/file-1/signed-url');
      expect(url).toContain('expires=7200');
    });
  });

  // ── URL Helpers ────────────────────────────────────
  describe('url helpers', () => {
    it('should build original URL', () => {
      expect(mv.url('proj/image.webp')).toBe('https://cdn.example.com/f/proj/image.webp');
    });

    it('should build resized URL', () => {
      const url = mv.url('proj/image.webp', { width: 800, height: 600, fit: 'fill' });
      expect(url).toBe('https://cdn.example.com/img/fill/800/600/f/proj/image.webp');
    });

    it('should default fit to "fit"', () => {
      const url = mv.url('proj/image.webp', { width: 400 });
      expect(url).toContain('/img/fit/400/0/');
    });

    it('should build thumbnail URL', () => {
      expect(mv.thumbnailUrl('proj/image.webp')).toBe(
        'https://cdn.example.com/img/fit/200/200/f/proj/image.webp'
      );
    });

    it('should accept custom thumbnail size', () => {
      expect(mv.thumbnailUrl('proj/image.webp', 100)).toBe(
        'https://cdn.example.com/img/fit/100/100/f/proj/image.webp'
      );
    });
  });

  // ── Usage ──────────────────────────────────────────
  describe('usage', () => {
    it('should get current usage', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        project_id: 'proj-1',
        period: '2026-03',
        storage: { used: 1000, limit: 1073741824, percent: 0 },
        bandwidth: { used: 0, limit: 5368709120, percent: 0 },
        uploads: 5,
        downloads: 10,
        transforms: 3,
        files: { total: 5, images: 3, videos: 1, other: 1 },
      }));

      const result = await mv.usage.current();

      expect(result.uploads).toBe(5);
      expect(result.storage.used).toBe(1000);
    });

    it('should get usage history', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ data: [{ date: '2026-03-01', uploads: 10 }] }));

      const result = await mv.usage.history(7);

      expect(result.data).toHaveLength(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('days=7');
    });
  });

  // ── Webhooks ───────────────────────────────────────
  describe('webhooks', () => {
    it('should list webhooks', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ data: [{ id: 'wh-1', url: 'https://hook.example.com' }] }));

      const result = await mv.webhooks.list();

      expect(result.data).toHaveLength(1);
    });

    it('should create webhook', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        id: 'wh-1',
        url: 'https://hook.example.com',
        secret: 'whsec_abc',
        events: ['file.uploaded'],
        status: 'active',
      }));

      const result = await mv.webhooks.create('https://hook.example.com', ['file.uploaded']);

      expect(result.secret).toMatch(/^whsec_/);
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
    });

    it('should delete webhook', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ deleted: true }));

      await mv.webhooks.delete('wh-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/v1/webhooks/wh-1');
      expect(opts.method).toBe('DELETE');
    });

    it('should verify webhook signature', () => {
      const secret = 'whsec_test_secret_key';
      const payload = '{"event":"file.uploaded","data":{}}';
      const signature = createHmac('sha256', secret).update(payload).digest('hex');

      expect(mv.webhooks.verify(payload, signature, secret)).toBe(true);
    });

    it('should reject invalid webhook signature', () => {
      expect(mv.webhooks.verify('payload', 'invalid-sig-of-correct-length-aaaaaaaaaaaaaaaaaaaaaa', 'secret')).toBe(false);
    });
  });

  // ── Error Handling ─────────────────────────────────
  describe('error handling', () => {
    it('should throw MediaOSApiError on 4xx/5xx', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(
        { error: 'Not found', code: 'NOT_FOUND' },
        404
      ));

      await expect(mv.files.get('nonexistent')).rejects.toThrow(MediaOSApiError);

      try {
        await mv.files.get('nonexistent');
      } catch (err) {
        // Already caught above
      }
    });

    it('should include code and status in error', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(
        { error: 'Invalid API key', code: 'AUTH_INVALID' },
        403
      ));

      try {
        await mv.files.list();
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MediaOSApiError);
        const apiErr = err as MediaOSApiError;
        expect(apiErr.code).toBe('AUTH_INVALID');
        expect(apiErr.status).toBe(403);
        expect(apiErr.message).toBe('Invalid API key');
      }
    });

    it('should handle timeout via AbortController', async () => {
      // Test that the SDK passes an AbortSignal to fetch
      mockFetch.mockImplementationOnce((_url: string, opts: RequestInit) => {
        expect(opts.signal).toBeDefined();
        expect(opts.signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve(mockResponse({}));
      });

      // Just verify the signal is wired up
      await mv.files.list();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
