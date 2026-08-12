const { mockDb } = require('../setup');
const { applyAccessDeltas } = require('../../src/services/lifecycleFlushService');

beforeEach(() => {
  mockDb.reset();
});

describe('applyAccessDeltas', () => {
  it('is a no-op for an empty batch', async () => {
    const r = await applyAccessDeltas([]);
    expect(r).toEqual({ files: 0, rows: 0 });
    expect(mockDb.queryCalls).toHaveLength(0);
  });

  it('sums per (file, day) into one access_daily UPSERT each', async () => {
    await applyAccessDeltas([
      { fileId: 'f1', day: '2026-08-10', downloads: 2, transforms: 1, lastSeenMs: 1000 },
      { fileId: 'f1', day: '2026-08-10', downloads: 3 },
      { fileId: 'f1', day: '2026-08-11', videoPlays: 1, lastSeenMs: 5000 },
    ]);

    const upserts = mockDb.queryCalls.filter((c) => c.text.includes('INSERT INTO access_daily'));
    expect(upserts).toHaveLength(2);

    const aug10 = upserts.find((c) => c.params[1] === '2026-08-10');
    // params: file_id, day, downloads, transforms, video_plays
    expect(aug10.params[0]).toBe('f1');
    expect(aug10.params[2]).toBe(5); // downloads 2+3
    expect(aug10.params[3]).toBe(1); // transforms
    expect(aug10.params[4]).toBe(0); // video_plays

    const aug11 = upserts.find((c) => c.params[1] === '2026-08-11');
    expect(aug11.params[4]).toBe(1); // video_plays
    // The UPSERT adds to existing counters rather than overwriting.
    expect(aug10.text).toContain('access_daily.downloads + EXCLUDED.downloads');
  });

  it('increments files.access_count by the file total and advances last_accessed_at to the max seen', async () => {
    const r = await applyAccessDeltas([
      { fileId: 'f1', day: '2026-08-10', downloads: 2, transforms: 1, lastSeenMs: 1000 },
      { fileId: 'f1', day: '2026-08-11', videoPlays: 1, lastSeenMs: 5000 },
    ]);

    expect(r.files).toBe(1);
    const upd = mockDb.queryCalls.find((c) => c.text.includes('UPDATE files'));
    expect(upd.params[0]).toBe('f1');
    expect(upd.params[1]).toBe(4); // 2 + 1 + 1
    expect(upd.params[2]).toBe(5); // greatest last-seen in seconds (5000ms)
    expect(upd.text).toContain('GREATEST');
  });

  it('updates last_accessed_at without a count when only a last-seen is supplied', async () => {
    await applyAccessDeltas([{ fileId: 'f1', day: '2026-08-10', lastSeenMs: 7000 }]);
    const upd = mockDb.queryCalls.find((c) => c.text.includes('UPDATE files'));
    expect(upd).toBeDefined();
    expect(upd.params[1]).toBe(0);   // no count delta
    expect(upd.params[2]).toBe(7);   // last-seen seconds
  });
});
