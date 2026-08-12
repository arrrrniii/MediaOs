/**
 * Video HLS pipeline end-to-end against REAL ffmpeg + Postgres + MinIO
 * (Phase 8b). Generates a tiny lavfi test clip, runs the real media processor,
 * and asserts that a master playlist, at least one rendition, and a poster land
 * in MinIO and are served with the right content types — plus that a signed
 * private video's segment refuses to serve without a token.
 *
 * Skipped unless REDIS_URL/REDIS_TEST is set AND ffmpeg is on PATH, so the
 * default `npm test` stays green offline. Does NOT require ../setup — it must
 * hit the real db/minio/ffmpeg, not the unit mocks.
 */

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function ffmpegPresent() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

const hasInfra = !!(process.env.REDIS_URL || process.env.REDIS_TEST) && ffmpegPresent();
const d = hasInfra ? describe : describe.skip;

d('video HLS pipeline (real ffmpeg + minio)', () => {
  const request = require('supertest');
  const { query, pool } = require('../../src/db');
  const minio = require('../../src/minio');
  const { hmacSha256 } = require('../../src/utils/crypto');
  const { processMediaJob } = require('../../src/queue/processors/media');
  const createApp = require('../../src/app');

  const suffix = crypto.randomBytes(4).toString('hex');
  const SIGNING_SECRET = 'a'.repeat(64);
  let accountId, projectId, fileId, app;
  let tempKey, finalKey, baseKey;

  async function objectExists(key) {
    try { await minio.statObject(key); return true; } catch { return false; }
  }

  beforeAll(async () => {
    await minio.ensureBucket();
    app = createApp();

    const acc = await query(
      `INSERT INTO accounts (name, email) VALUES ($1, $2) RETURNING id`,
      [`HLS Test ${suffix}`, `hls-${suffix}@example.com`]
    );
    accountId = acc.rows[0].id;
    const proj = await query(
      `INSERT INTO projects (account_id, name, slug, signing_secret) VALUES ($1, $2, $3, $4) RETURNING id`,
      [accountId, 'HLS', `hls-${suffix}`, SIGNING_SECRET]
    );
    projectId = proj.rows[0].id;

    // A 2s 640x360 test clip with a tone, so the ladder yields 360p only.
    const clip = path.join(os.tmpdir(), `hls_src_${suffix}.mp4`);
    execFileSync('ffmpeg', [
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', clip,
    ], { stdio: 'ignore' });

    finalKey = `${projectId}/clip-${suffix}.mp4`;
    baseKey = `${projectId}/clip-${suffix}`;
    tempKey = `_processing_${suffix}.mp4`;
    await minio.putFile(tempKey, clip, 'video/mp4');
    fs.promises.unlink(clip).catch(() => {});

    const file = await query(
      `INSERT INTO files (project_id, storage_key, filename, original_name, type, mime_type, size, original_size, status, access)
       VALUES ($1, $2, $3, $4, 'video', 'video/mp4', 0, 100000, 'processing', 'public') RETURNING id`,
      [projectId, finalKey, path.basename(finalKey), 'src.mp4']
    );
    fileId = file.rows[0].id;

    await processMediaJob({
      fileId, projectId, tempKey, finalKey, kind: 'video',
      originalMime: 'video/mp4', originalExt: '.mp4',
    });
  }, 120000);

  afterAll(async () => {
    // Remove every object we created under the file's prefix, then DB rows.
    try {
      const objs = await query('SELECT storage_key FROM file_objects WHERE file_id = $1', [fileId]);
      for (const o of objs.rows) await minio.removeObject(o.storage_key).catch(() => {});
    } catch { /* noop */ }
    await minio.removeObject(finalKey).catch(() => {});
    await minio.removeObject(tempKey).catch(() => {});
    try { await query('DELETE FROM accounts WHERE id = $1', [accountId]); } catch { /* cascade */ }
    await pool.end();
  });

  test('records hls, poster, optimized, and at least one video rendition object', async () => {
    const { rows } = await query('SELECT role, storage_key, mime_type FROM file_objects WHERE file_id = $1', [fileId]);
    const roles = rows.map((r) => r.role);
    expect(roles).toEqual(expect.arrayContaining(['hls', 'poster', 'optimized', 'video_360p']));
    // has_hls + poster flagged on the file.
    const f = await query('SELECT has_hls, video_status, poster_key FROM files WHERE id = $1', [fileId]);
    expect(f.rows[0].has_hls).toBe(true);
    expect(f.rows[0].video_status).toBe('ready');
    expect(f.rows[0].poster_key).toBeTruthy();
  });

  test('master playlist, a rendition playlist, segments, and poster are in MinIO', async () => {
    expect(await objectExists(`${baseKey}/hls/master.m3u8`)).toBe(true);
    expect(await objectExists(`${baseKey}/hls/360p/index.m3u8`)).toBe(true);
    expect(await objectExists(`${baseKey}/hls/360p/seg_000.ts`)).toBe(true);
    expect(await objectExists(`${baseKey}/hls/poster.jpg`)).toBe(true);
  });

  test('serves the master playlist and segment with the right content types', async () => {
    const master = await request(app).get(`/f/${baseKey}/hls/master.m3u8`);
    expect(master.status).toBe(200);
    expect(master.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(master.text).toContain('360p/index.m3u8');

    const seg = await request(app).get(`/f/${baseKey}/hls/360p/seg_000.ts`);
    expect(seg.status).toBe(200);
    expect(seg.headers['content-type']).toContain('video/MP2T');
  });

  test('a signed private video refuses a segment without a token, allows it with one', async () => {
    await query("UPDATE files SET access = 'signed' WHERE id = $1", [fileId]);
    const segKey = `${baseKey}/hls/360p/seg_000.ts`;

    const denied = await request(app).get(`/f/${segKey}`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ACCESS_DENIED');

    const expires = Math.floor(Date.now() / 1000) + 3600;
    const token = hmacSha256(SIGNING_SECRET, `${segKey}:${expires}`);
    const allowed = await request(app).get(`/f/${segKey}?token=${token}&expires=${expires}`);
    expect(allowed.status).toBe(200);
    expect(allowed.headers['cache-control']).toBe('private, no-store');
  });
});
