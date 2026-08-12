const request = require('supertest');
const { createTestApp, mockDb, mockMinio, testProject, testFile } = require('../setup');
const { hmacSha256 } = require('../../src/utils/crypto');
const transformCacheService = require('../../src/services/transformCacheService');

let app;
let originalFetch;

const SECRET = testProject.signing_secret;
const KEY = testFile.storage_key;

/** Row the /img/ (raw) and /img/v/ (variant) routes look up. */
function imgFile(overrides = {}) {
  mockDb.onQuery('SELECT f.access, f.id, f.project_id', {
    rows: [{
      access: 'public',
      id: testFile.id,
      project_id: testFile.project_id,
      cache_version: 1,
      signing_secret: SECRET,
      project_settings: {},
      ...overrides,
    }],
  });
}

/** Resolve a stored variant (or [] for the built-in fallback). */
function variantRows(rows) {
  mockDb.onQuery('FROM named_variants WHERE project_id', { rows });
}

function storeCacheObject(fileId, cacheVersion, variantKey, format) {
  const key = transformCacheService.cacheStorageKey(fileId, cacheVersion, variantKey, format);
  const buffer = Buffer.from('cached-transform-bytes');
  mockMinio.objects[key] = { buffer, contentType: `image/${format}`, size: buffer.length };
  return key;
}

beforeEach(() => {
  mockDb.reset();
  mockMinio.reset();
  app = createTestApp();
  originalFetch = global.fetch;
  global.fetch = jest.fn(async () => new Response(Buffer.from('transformed-bytes'), {
    headers: { 'content-type': 'image/webp' },
  }));
});

afterEach(() => {
  global.fetch = originalFetch;
});

const tick = () => new Promise((r) => setImmediate(r));

describe('AVIF/WebP negotiation', () => {
  it('renders AVIF when the client advertises image/avif', async () => {
    imgFile({ access: 'public' });
    const res = await request(app)
      .get(`/img/fit/200/200/f/${KEY}`)
      .set('Accept', 'image/avif,image/webp,*/*');
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('@avif');
  });

  it('falls back to WebP without an avif Accept', async () => {
    imgFile({ access: 'public' });
    const res = await request(app)
      .get(`/img/fit/200/200/f/${KEY}`)
      .set('Accept', 'image/webp,*/*');
    expect(res.status).toBe(200);
    expect(global.fetch.mock.calls[0][0]).toContain('@webp');
  });

  it('honors an explicit format param over negotiation', async () => {
    imgFile({ access: 'public' });
    const res = await request(app)
      .get(`/img/fit/200/200/f/${KEY}?format=png`)
      .set('Accept', 'image/avif');
    expect(res.status).toBe(200);
    expect(global.fetch.mock.calls[0][0]).toContain('@png');
  });
});

describe('Named variant route /img/v/:variant', () => {
  it('serves a built-in variant (thumbnail) for a project with none stored', async () => {
    imgFile({ access: 'public' });
    variantRows([]);
    const res = await request(app).get(`/img/v/thumbnail/f/${KEY}`);
    expect(res.status).toBe(200);
    // thumbnail = fit 200x200
    expect(global.fetch.mock.calls[0][0]).toContain('resize:fit:200:200');
  });

  it('negotiates avif for an auto-format variant', async () => {
    imgFile({ access: 'public' });
    variantRows([]);
    const res = await request(app)
      .get(`/img/v/hero/f/${KEY}`)
      .set('Accept', 'image/avif');
    expect(res.status).toBe(200);
    expect(global.fetch.mock.calls[0][0]).toContain('@avif');
    expect(global.fetch.mock.calls[0][0]).toContain('resize:fit:1600:0');
  });

  it('uses a stored variant format over negotiation', async () => {
    imgFile({ access: 'public' });
    variantRows([{ id: 'v1', project_id: testFile.project_id, name: 'card', mode: 'fill', width: 600, height: 400, format: 'jpeg', quality: 80 }]);
    const res = await request(app)
      .get(`/img/v/card/f/${KEY}`)
      .set('Accept', 'image/avif');
    expect(res.status).toBe(200);
    expect(global.fetch.mock.calls[0][0]).toContain('@jpeg');
    expect(global.fetch.mock.calls[0][0]).toContain('quality:80');
  });

  it('404s an unknown, non-built-in variant', async () => {
    imgFile({ access: 'public' });
    variantRows([]);
    const res = await request(app).get(`/img/v/bogus/f/${KEY}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('UNKNOWN_VARIANT');
  });
});

describe('strict_transforms allowlist', () => {
  it('denies an arbitrary raw transform when strict_transforms is on', async () => {
    imgFile({ access: 'public', project_settings: { strict_transforms: true } });
    const res = await request(app).get(`/img/fit/321/123/f/${KEY}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STRICT_TRANSFORMS');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('still allows named variants when strict_transforms is on', async () => {
    imgFile({ access: 'public' });
    variantRows([]);
    const res = await request(app).get(`/img/v/thumbnail/f/${KEY}`);
    expect(res.status).toBe(200);
  });
});

describe('transform cache', () => {
  it('serves a cache HIT without calling imgproxy', async () => {
    imgFile({ access: 'public' });
    storeCacheObject(testFile.id, 1, transformCacheService.rawVariantKey('fit', 200, 200), 'webp');
    const res = await request(app)
      .get(`/img/fit/200/200/f/${KEY}`)
      .set('Accept', 'image/webp');
    expect(res.status).toBe(200);
    expect(res.headers['x-transform-cache']).toBe('HIT');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('stores a MISS to the persistent cache for public files', async () => {
    imgFile({ access: 'public' });
    const res = await request(app)
      .get(`/img/fit/200/200/f/${KEY}`)
      .set('Accept', 'image/webp');
    expect(res.status).toBe(200);
    expect(res.headers['x-transform-cache']).toBe('MISS');
    await tick();
    const cacheWrites = mockMinio.putBufferCalls.filter((c) => c.key.startsWith('_cache/'));
    expect(cacheWrites.length).toBe(1);
  });

  it('never persists a transform of a private/signed file', async () => {
    imgFile({ access: 'signed' });
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const token = hmacSha256(SECRET, `${KEY}:fit:200:200:webp:${expires}`);
    const res = await request(app)
      .get(`/img/fit/200/200/f/${KEY}?token=${token}&expires=${expires}`)
      .set('Accept', 'image/webp');
    expect(res.status).toBe(200);
    expect(res.headers['x-transform-cache']).toBe('BYPASS');
    await tick();
    const cacheWrites = mockMinio.putBufferCalls.filter((c) => c.key.startsWith('_cache/'));
    expect(cacheWrites.length).toBe(0);
  });
});

describe('transformCacheService.purge', () => {
  it('deletes known cache objects and bumps cache_version', async () => {
    mockDb.onQuery('SELECT storage_key FROM transform_cache', {
      rows: [{ storage_key: '_cache/v1/file-1/r_fit_200x200.webp' }],
    });
    mockDb.onQuery('DELETE FROM transform_cache', { rowCount: 1 });
    mockDb.onQuery('UPDATE files SET cache_version', { rows: [{ cache_version: 2 }] });

    const result = await transformCacheService.purge('file-1', 'proj-1');
    expect(result.cache_version).toBe(2);
    expect(result.objects_removed).toBe(1);
    expect(result.purged).toBe(true);
    expect(mockMinio.removedKeys).toContain('_cache/v1/file-1/r_fit_200x200.webp');
  });
});
