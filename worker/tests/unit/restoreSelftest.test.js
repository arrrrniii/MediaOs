const { Readable } = require('stream');
const { runRestoreSelftest } = require('../../src/observability/restoreSelftest');
const metrics = require('../../src/observability/metrics');

async function restoreTestCount(result) {
  const m = await metrics._metrics.restoreTestsTotal.get();
  const row = m.values.find((v) => v.labels.result === result);
  return row ? row.value : 0;
}

describe('restore self-test', () => {
  it('no-ops cleanly when disabled', async () => {
    const r = await runRestoreSelftest({ enabled: false });
    expect(r).toEqual({ skipped: true, reason: 'disabled' });
  });

  it('runs a hot round-trip, verifies checksum, stamps setLastRestoreTestAt + metric', async () => {
    const store = {};
    const client = {
      putBuffer: async (key, buffer) => { store[key] = Buffer.from(buffer); },
      getObject: async (key) => Readable.from([store[key]]),
      removeObject: async (key) => { delete store[key]; },
    };
    const storage = {
      getDefaultBackend: async () => ({ id: 'hot' }),
      getBackendClient: () => client,
      resolveColdBackend: async () => null,   // no cold backend → hot round-trip
    };
    const setLastRestoreTestAt = jest.fn(async () => '2026-08-12T00:00:00.000Z');

    const before = await restoreTestCount('pass');
    const r = await runRestoreSelftest({
      enabled: true,
      storage,
      health: { setLastRestoreTestAt },
    });

    expect(r.ok).toBe(true);
    expect(r.mode).toBe('hot_roundtrip');
    expect(setLastRestoreTestAt).toHaveBeenCalledTimes(1);
    expect(await restoreTestCount('pass')).toBe(before + 1);
    // Probe cleaned up.
    expect(Object.keys(store)).toHaveLength(0);
  });

  it('records a failure (and no restore stamp) when the checksum does not verify', async () => {
    const client = {
      putBuffer: async () => {},
      getObject: async () => Readable.from([Buffer.from('tampered')]),
      removeObject: async () => {},
    };
    const storage = {
      getDefaultBackend: async () => ({ id: 'hot' }),
      getBackendClient: () => client,
      resolveColdBackend: async () => null,
    };
    const setLastRestoreTestAt = jest.fn();

    const beforeFail = await restoreTestCount('fail');
    const r = await runRestoreSelftest({ enabled: true, storage, health: { setLastRestoreTestAt } });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/checksum/);
    expect(setLastRestoreTestAt).not.toHaveBeenCalled();
    expect(await restoreTestCount('fail')).toBe(beforeFail + 1);
  });
});
