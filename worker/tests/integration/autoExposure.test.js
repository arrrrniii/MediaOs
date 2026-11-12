const request = require('supertest');
const { createTestApp, mockDb, mockMinio, testApiKey, testFile, testProject } = require('../setup');
const { sha256 } = require('../../src/utils/crypto');
const minio = require('../../src/minio');

jest.dontMock('sharp');
const sharp = require('sharp');
const { processImage } = require('../../src/services/imageProcessor');

const KEY = 'mv_live_test0123456789abcdef0123456789ab';
const PROFILE = 'auto_exposure_v1';

let app;

beforeEach(() => {
  mockDb.reset();
  mockMinio.reset();
  app = createTestApp();
});

function authenticate() {
  mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
    rows: [{ ...testApiKey, key_prefix: KEY.substring(0, 12), key_hash: sha256(KEY) }],
  });
  mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });
}

async function photo({ dark = true, alpha = false, jpeg = false } = {}) {
  const width = 240;
  const height = 160;
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    const level = (dark ? 24 : 110) + Math.floor(((i / 3) % width) / 3);
    data.set([level + 5, level, level - 5], i);
  }
  const image = sharp(data, { raw: { width, height, channels: 3 } });
  if (alpha) image.ensureAlpha(0.5);
  return jpeg ? image.withMetadata({ orientation: 6 }).jpeg().toBuffer() : image.webp().toBuffer();
}

function upload(bytes, { access = 'private', enhance = true, jpeg = false } = {}) {
  authenticate();
  const req = request(app).post('/api/v1/upload').set('X-API-Key', KEY).field('access', access);
  if (enhance) req.field('image_enhancement', 'auto_exposure');
  return req.attach('file', bytes, jpeg ? 'dish.jpg' : 'dish.webp');
}

function dedupLookup() {
  return mockDb.queryCalls.find(({ text }) => text.includes('AND content_hash = $2'));
}

function fileInsert() {
  return mockDb.queryCalls.find(({ text }) => text.includes('INSERT INTO files'));
}

it.each([false, true])('brightens a dark private photo and keeps its exact input (JPEG: %s)', async (jpeg) => {
  const input = await photo({ jpeg });
  const reference = await processImage(input);
  mockDb.onQuery('INSERT INTO files', {
    rows: [{ ...testFile, access: 'private', metadata: { image_enhancement: PROFILE } }],
  });

  const res = await upload(input, { jpeg });

  expect(res.status).toBe(200);
  expect(res.body.image_enhancement).toBe(PROFILE);
  expect(res.body.access).toBe('private');
  expect(res.body.objects.map(({ role }) => role)).toEqual(['source', 'optimized']);
  const [source, output] = mockMinio.putBufferCalls;
  expect(source.buffer).toEqual(input);
  expect(output.key).not.toBe(source.key);
  const out = await sharp(output.buffer).metadata();
  expect([out.width, out.height]).toEqual(jpeg ? [160, 240] : [240, 160]);
  expect(out.exif).toBeUndefined();
  const originalStats = await sharp(reference.buffer).stats();
  const enhancedStats = await sharp(output.buffer).stats();
  expect(enhancedStats.channels[1].mean).toBeGreaterThan(originalStats.channels[1].mean + 8);
  expect(dedupLookup().text).toContain("(metadata->>'image_enhancement') IS NOT DISTINCT FROM $5::text");
  expect(dedupLookup().params).toEqual([testProject.id, sha256(input), 'private', 'image', PROFILE]);
  expect(fileInsert().params[17]).toBe(sha256(input));
  expect(fileInsert().params[19]).toBe(sha256(input));
  expect(JSON.parse(fileInsert().params[21])).toEqual({ image_enhancement: PROFILE });
});

it.each([
  ['well-exposed photo', { dark: false }, {}],
  ['transparent image', { alpha: true }, {}],
  ['public image', {}, { access: 'public' }],
  ['unmarked image', {}, { enhance: false }],
])('uses standard optimization for %s', async (_label, pixels, options) => {
  const input = await photo(pixels);
  const reference = await processImage(input);
  mockDb.onQuery('INSERT INTO files', { rows: [testFile] });

  const res = await upload(input, options);

  expect(res.status).toBe(200);
  expect(res.body.image_enhancement).toBeUndefined();
  expect(res.body.objects.map(({ role }) => role)).toEqual(['optimized']);
  expect(mockMinio.putBufferCalls[0].buffer).toEqual(reference.buffer);
  expect(dedupLookup().params[4]).toBeNull();
  expect(JSON.parse(fileInsert().params[21])).toEqual({});
});

it('uploads normally if the source for an optional correction cannot be verified', async () => {
  const input = await photo();
  const reference = await processImage(input);
  mockDb.onQuery('INSERT INTO files', { rows: [testFile] });
  minio.statObject.mockRejectedValueOnce(new Error('Storage unavailable'));

  const res = await upload(input);

  expect(res.status).toBe(200);
  expect(res.body.image_enhancement).toBeUndefined();
  expect(res.body.objects.map(({ role }) => role)).toEqual(['optimized']);
  const [source, output] = mockMinio.putBufferCalls;
  expect(mockMinio.removedKeys).toEqual([source.key]);
  expect(output.buffer).toEqual(reference.buffer);
  expect(fileInsert().params[17]).toBe(sha256(output.buffer));
  expect(JSON.parse(fileInsert().params[21])).toEqual({});
});

it('reuses corrected bytes only under the same enhancement profile', async () => {
  const input = await photo();
  mockDb.onQuery('AND content_hash = $2', {
    rows: [{ ...testFile, id: 'adjusted-file', access: 'private', content_hash: sha256(input) }],
  });
  mockDb.onQuery('INSERT INTO files', {
    rows: [{ ...testFile, access: 'private', metadata: { image_enhancement: PROFILE } }],
  });

  const res = await upload(input);

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ deduped: true, dedup_of: 'adjusted-file', image_enhancement: PROFILE });
  expect(dedupLookup().params[4]).toBe(PROFILE);
  expect(JSON.parse(fileInsert().params[16])).toMatchObject({ image_enhancement: PROFILE });
  expect(mockMinio.putBufferCalls).toHaveLength(0);
});

it('uploads normally when the exposure operation fails', async () => {
  const input = await photo();
  const reference = await processImage(input);
  mockDb.onQuery('INSERT INTO files', { rows: [testFile] });
  const gamma = jest.spyOn(sharp.prototype, 'gamma').mockImplementationOnce(() => {
    throw new Error('Exposure adjustment failed');
  });

  try {
    const res = await upload(input);
    expect(gamma).toHaveBeenCalledWith(1, 1.18);
    expect(res.status).toBe(200);
    expect(res.body.image_enhancement).toBeUndefined();
    expect(res.body.objects.map(({ role }) => role)).toEqual(['optimized']);
    expect(mockMinio.putBufferCalls[0].buffer).toEqual(reference.buffer);
    expect(JSON.parse(fileInsert().params[21])).toEqual({});
  } finally {
    gamma.mockRestore();
  }
});
