const request = require('supertest');
const { createTestApp, mockDb, mockMinio, testProject, testFile } = require('../setup');
const { hmacSha256 } = require('../../src/utils/crypto');

let app;
let originalFetch;

const SECRET = testProject.signing_secret;
const KEY = testFile.storage_key; // proj-test-id/test-image-abc123.webp
const BODY = Buffer.from('binary-file-body');

function storeObject(key = KEY, buffer = BODY, contentType = 'image/webp') {
  mockMinio.objects[key] = { buffer, contentType, size: buffer.length };
}

/** Register the file row the /f/ route looks up. */
function serveFile(overrides = {}) {
  mockDb.onQuery('SELECT f.*, p.signing_secret', {
    rows: [{ ...testFile, signing_secret: SECRET, ...overrides }],
  });
}

/** Register the (narrower) row the /img/ route looks up. */
function transformFile(overrides = {}) {
  mockDb.onQuery('SELECT f.access, f.id, f.project_id, p.signing_secret', {
    rows: [{
      access: testFile.access,
      id: testFile.id,
      project_id: testFile.project_id,
      signing_secret: SECRET,
      ...overrides,
    }],
  });
}

function signOriginal(storageKey = KEY, ttl = 3600) {
  const expires = Math.floor(Date.now() / 1000) + ttl;
  return { token: hmacSha256(SECRET, `${storageKey}:${expires}`), expires };
}

function signTransform({ mode, width, height, format = 'webp', storageKey = KEY, ttl = 3600 }) {
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${storageKey}:${mode}:${width}:${height}:${format}:${expires}`;
  return { token: hmacSha256(SECRET, payload), expires };
}

beforeEach(() => {
  mockDb.reset();
  mockMinio.reset();
  app = createTestApp();
  originalFetch = global.fetch;
  global.fetch = jest.fn(async () => new Response(Buffer.from('transformed'), {
    headers: { 'content-type': 'image/webp' },
  }));
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('GET /f/* — caching and content safety', () => {
  it('caches public files immutably and allows any origin', async () => {
    serveFile({ access: 'public' });
    storeObject();

    const res = await request(app).get(`/f/${KEY}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['cdn-cache-control']).toContain('public');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never caches a signed file, even with a valid token', async () => {
    serveFile({ access: 'signed' });
    storeObject();
    const { token, expires } = signOriginal();

    const res = await request(app).get(`/f/${KEY}?token=${token}&expires=${expires}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['cache-control']).not.toContain('immutable');
    expect(res.headers['cdn-cache-control']).toBe('no-store');
    expect(res.headers['surrogate-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never caches a private file', async () => {
    serveFile({ access: 'private' });
    storeObject();
    const { token, expires } = signOriginal();

    const res = await request(app).get(`/f/${KEY}?token=${token}&expires=${expires}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('still refuses a private file without a token', async () => {
    serveFile({ access: 'private' });
    storeObject();

    const res = await request(app).get(`/f/${KEY}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCESS_DENIED');
  });

  it('rejects an expired signed URL', async () => {
    serveFile({ access: 'signed' });
    storeObject();
    const { token, expires } = signOriginal(KEY, -60);

    const res = await request(app).get(`/f/${KEY}?token=${token}&expires=${expires}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('URL_EXPIRED');
  });

  it('forces non-media downloads to be saved rather than rendered', async () => {
    const key = 'proj-test-id/report-abc123.pdf';
    serveFile({
      storage_key: key,
      filename: 'report-abc123.pdf',
      type: 'file',
      mime_type: 'application/pdf',
    });
    storeObject(key, BODY, 'application/pdf');

    const res = await request(app).get(`/f/${key}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('report-abc123.pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sandboxes SVG with a restrictive CSP', async () => {
    const key = 'proj-test-id/logo-abc123.svg';
    serveFile({
      storage_key: key,
      filename: 'logo-abc123.svg',
      type: 'image',
      mime_type: 'image/svg+xml',
    });
    storeObject(key, Buffer.from('<svg></svg>'), 'image/svg+xml');

    const res = await request(app).get(`/f/${key}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    );
  });

  it('answers a malformed Range with 416 instead of a NaN read', async () => {
    serveFile({ access: 'public' });
    storeObject();

    const res = await request(app).get(`/f/${KEY}`).set('Range', 'bytes=abc-');

    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${BODY.length}`);
  });

  it('serves a valid Range as 206', async () => {
    serveFile({ access: 'public' });
    storeObject();

    // The MinIO mock always replies with a fixed 7-byte partial body, so the
    // requested range has to match that length for the response to be well formed.
    const res = await request(app).get(`/f/${KEY}`).set('Range', 'bytes=0-6');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-6/${BODY.length}`);
  });
});

describe('GET /img/* — validation and caching', () => {
  it('caches public transforms immutably', async () => {
    transformFile({ access: 'public' });

    const res = await request(app).get(`/img/fit/200/200/f/${KEY}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never caches a transform of a private file', async () => {
    transformFile({ access: 'signed' });
    const { token, expires } = signTransform({ mode: 'fit', width: '200', height: '200' });

    const res = await request(app).get(`/img/fit/200/200/f/${KEY}?token=${token}&expires=${expires}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a transform of a private file without a token', async () => {
    transformFile({ access: 'private' });

    const res = await request(app).get(`/img/fit/200/200/f/${KEY}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCESS_DENIED');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects dimensions beyond the transform cap', async () => {
    const res = await request(app).get(`/img/fit/99999/99999/f/${KEY}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DIMENSION_TOO_LARGE');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects non-integer dimensions', async () => {
    const res = await request(app).get(`/img/fit/abc/200/f/${KEY}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DIMENSIONS');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects a zero-by-zero resize', async () => {
    const res = await request(app).get(`/img/fit/0/0/f/${KEY}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DIMENSIONS');
  });

  it('accepts a single zero axis (auto-derived side)', async () => {
    transformFile({ access: 'public' });

    const res = await request(app).get(`/img/fit/400/0/f/${KEY}`);

    expect(res.status).toBe(200);
  });

  it('rejects an unknown output format', async () => {
    const res = await request(app).get(`/img/fit/200/200/f/${KEY}?format=exe`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FORMAT');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('accepts the allowlisted formats and forwards them to imgproxy', async () => {
    transformFile({ access: 'public' });

    const res = await request(app).get(`/img/fit/200/200/f/${KEY}?format=avif`);

    expect(res.status).toBe(200);
    expect(global.fetch.mock.calls[0][0]).toContain('@avif');
  });

  it('rejects an unknown resize type', async () => {
    const res = await request(app).get(`/img/stretch/200/200/f/${KEY}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESIZE_TYPE');
  });
});
