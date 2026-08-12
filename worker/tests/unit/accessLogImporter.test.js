const fs = require('fs');
const path = require('path');
const os = require('os');
const { mockDb } = require('../setup');
const { parseAccessLine, importAccessLog } = require('../../src/services/accessLogImporter');

beforeEach(() => {
  mockDb.reset();
});

describe('parseAccessLine', () => {
  const T = '2026-08-10T12:00:00+00:00';

  it('maps a successful /f/ request to a download', () => {
    const r = parseAccessLine(`${T}\t200\t1234\tGET\t/f/proj-1/photos/sunset-abc123.webp`);
    expect(r).toEqual({
      kind: 'download',
      storageKey: 'proj-1/photos/sunset-abc123.webp',
      day: '2026-08-10',
      lastSeenMs: Date.parse(T),
    });
  });

  it('maps a successful /img/ transform to a transform, extracting the key after /f/', () => {
    const r = parseAccessLine(`${T}\t200\t900\tGET\t/img/fit/200/200/f/proj-1/a.webp`);
    expect(r.kind).toBe('transform');
    expect(r.storageKey).toBe('proj-1/a.webp');
  });

  it('counts a 206 partial (ranged video) response', () => {
    const r = parseAccessLine(`${T}\t206\t500\tGET\t/f/proj-1/clip.mp4`);
    expect(r.kind).toBe('download');
  });

  it('ignores non-200/206 statuses', () => {
    expect(parseAccessLine(`${T}\t404\t0\tGET\t/f/proj-1/missing.webp`)).toBeNull();
    expect(parseAccessLine(`${T}\t304\t0\tGET\t/f/proj-1/a.webp`)).toBeNull();
  });

  it('ignores non-GET methods and non-media paths', () => {
    expect(parseAccessLine(`${T}\t200\t0\tPOST\t/f/proj-1/a.webp`)).toBeNull();
    expect(parseAccessLine(`${T}\t200\t0\tGET\t/api/v1/projects`)).toBeNull();
  });

  it('returns null on a malformed line', () => {
    expect(parseAccessLine('garbage')).toBeNull();
    expect(parseAccessLine('')).toBeNull();
  });
});

describe('importAccessLog', () => {
  let logPath;

  afterEach(() => {
    if (logPath && fs.existsSync(logPath)) fs.unlinkSync(logPath);
  });

  it('no-ops cleanly when the log file is absent', async () => {
    const r = await importAccessLog(path.join(os.tmpdir(), 'does-not-exist-mediaos.log'));
    expect(r).toEqual({ imported: 0, lines: 0, offset: 0, skipped: true });
  });

  it('parses a sample log, resolves keys to files, and records the accesses', async () => {
    const T = '2026-08-10T12:00:00+00:00';
    logPath = path.join(os.tmpdir(), `mediaos-access-${Date.now()}.log`);
    fs.writeFileSync(logPath, [
      `${T}\t200\t1234\tGET\t/f/proj-1/a.webp`,
      `${T}\t200\t900\tGET\t/img/fit/200/200/f/proj-1/a.webp`,
      `${T}\t404\t0\tGET\t/f/proj-1/gone.webp`,
      '', // trailing newline
    ].join('\n'));

    // Offset starts at 0 (no kv row); both hits resolve to the same file.
    mockDb.onQuery('SELECT value FROM lifecycle_kv', { rows: [] });
    mockDb.onQuery('storage_key = ANY', { rows: [{ id: 'file-1', storage_key: 'proj-1/a.webp' }] });

    const r = await importAccessLog(logPath);

    // Two countable lines (the 404 is skipped), both mapped to file-1.
    expect(r.imported).toBe(2);
    expect(r.lines).toBe(3);

    const daily = mockDb.queryCalls.filter((c) => c.text.includes('INSERT INTO access_daily'));
    // Both accesses fall on the same file+day, so they collapse to one UPSERT.
    expect(daily).toHaveLength(1);
    expect(daily[0].params[0]).toBe('file-1');
    expect(daily[0].params[2]).toBe(1); // downloads
    expect(daily[0].params[3]).toBe(1); // transforms

    // Offset was advanced (idempotent re-runs).
    expect(mockDb.queryCalls.some((c) => c.text.includes('INSERT INTO lifecycle_kv'))).toBe(true);
    expect(r.offset).toBeGreaterThan(0);
  });
});
