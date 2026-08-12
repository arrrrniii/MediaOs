const request = require('supertest');
const { createTestApp, mockDb, mockMinio, testProject } = require('../setup');
const { hmacSha256 } = require('../../src/utils/crypto');

let app;
const SECRET = testProject.signing_secret;
const PROJECT = 'proj-test-id';
const BASE = `${PROJECT}/clip-x`;
const MASTER = `${BASE}/hls/master.m3u8`;
const MEDIA = `${BASE}/hls/720p/index.m3u8`;
const SEG = `${BASE}/hls/720p/seg_000.ts`;
const POSTER = `${BASE}/hls/poster.jpg`;

const MASTER_BODY = [
  '#EXTM3U', '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=952000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2"',
  '360p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3124000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  '720p/index.m3u8', '',
].join('\n');

/** Register the row the HLS handler looks up (keyed off the derived .mp4). */
function hlsFile(overrides = {}) {
  mockDb.onQuery('SELECT f.id, f.access, f.project_id, f.type, p.signing_secret', {
    rows: [{
      id: 'file-test-id', access: 'public', project_id: PROJECT, type: 'video',
      signing_secret: SECRET, ...overrides,
    }],
  });
}
function store(key, body, contentType) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  mockMinio.objects[key] = { buffer: buf, contentType, size: buf.length };
}
function sign(key, ttl = 3600) {
  const expires = Math.floor(Date.now() / 1000) + ttl;
  return { token: hmacSha256(SECRET, `${key}:${expires}`), expires };
}

beforeEach(() => {
  mockDb.reset();
  mockMinio.reset();
  app = createTestApp();
});

describe('HLS serving — content types & caching', () => {
  it('serves a public master playlist as vnd.apple.mpegurl, short-cached', async () => {
    hlsFile({ access: 'public' });
    store(MASTER, MASTER_BODY, 'application/vnd.apple.mpegurl');

    const res = await request(app).get(`/f/${MASTER}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    // Public playlist body is served verbatim (no token rewriting).
    expect(res.text).toContain('720p/index.m3u8');
    expect(res.text).not.toContain('token=');
  });

  it('serves a public segment as video/MP2T, immutably cached', async () => {
    hlsFile({ access: 'public' });
    store(SEG, 'ts-bytes', 'video/MP2T');

    const res = await request(app).get(`/f/${SEG}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('video/MP2T');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('serves a public poster as image/jpeg', async () => {
    hlsFile({ access: 'public' });
    store(POSTER, 'jpg-bytes', 'image/jpeg');

    const res = await request(app).get(`/f/${POSTER}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
  });
});

describe('HLS serving — access control', () => {
  it('refuses a private segment without a token', async () => {
    hlsFile({ access: 'private' });
    store(SEG, 'ts-bytes', 'video/MP2T');

    const res = await request(app).get(`/f/${SEG}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCESS_DENIED');
  });

  it('rejects an expired segment token with URL_EXPIRED', async () => {
    hlsFile({ access: 'signed' });
    store(SEG, 'ts-bytes', 'video/MP2T');
    const { token, expires } = sign(SEG, -60);

    const res = await request(app).get(`/f/${SEG}?token=${token}&expires=${expires}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('URL_EXPIRED');
  });

  it('rejects a segment token signed for a DIFFERENT key', async () => {
    hlsFile({ access: 'signed' });
    store(SEG, 'ts-bytes', 'video/MP2T');
    const { token, expires } = sign(`${BASE}/hls/360p/seg_000.ts`); // wrong key

    const res = await request(app).get(`/f/${SEG}?token=${token}&expires=${expires}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INVALID_SIGNATURE');
  });

  it('serves a signed segment with a valid token, never shared-cached', async () => {
    hlsFile({ access: 'signed' });
    store(SEG, 'ts-bytes', 'video/MP2T');
    const { token, expires } = sign(SEG);

    const res = await request(app).get(`/f/${SEG}?token=${token}&expires=${expires}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rewrites a signed master playlist so children carry their own tokens', async () => {
    hlsFile({ access: 'signed' });
    store(MASTER, MASTER_BODY, 'application/vnd.apple.mpegurl');
    const { token, expires } = sign(MASTER);

    const res = await request(app).get(`/f/${MASTER}?token=${token}&expires=${expires}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const childLines = res.text.split('\n').filter((l) => l.includes('index.m3u8'));
    expect(childLines).toHaveLength(2);
    for (const line of childLines) {
      expect(line).toMatch(/\?token=[a-f0-9]+&expires=\d+$/);
      expect(line).toContain(`expires=${expires}`);
    }
    // The rewritten 720p child token validates when that child is requested.
    const child720 = childLines.find((l) => l.startsWith('720p/'));
    const childToken = child720.match(/token=([a-f0-9]+)/)[1];
    const { validateOriginal } = require('../../src/services/signedUrl');
    expect(validateOriginal(SECRET, MEDIA, childToken, expires)).toBe(true);
  });
});
