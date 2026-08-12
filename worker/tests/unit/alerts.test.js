const alerts = require('../../src/observability/alerts');
const metrics = require('../../src/observability/metrics');

async function alertsTotalCount() {
  const m = await metrics._metrics.alertsTotal.get();
  return m.values.reduce((sum, v) => sum + v.value, 0);
}

describe('alert signals', () => {
  it('fires a warning + increments alerts_total when queue depth exceeds the threshold', async () => {
    const before = await alertsTotalCount();
    const snapshot = await alerts.evaluateAlerts({
      pool: {},                       // no saturation
      redis: null,                    // not configured
      getQueueDepths: async () => ({ total: 5000, byQueue: { media: 5000 } }),
      getDisk: async () => null,      // simulate statfs unavailable
    });

    const kinds = snapshot.alerts.map((a) => a.type);
    expect(kinds).toContain('queue_depth');
    expect(await alertsTotalCount()).toBeGreaterThan(before);
  });

  it('does not fire when everything is within thresholds', async () => {
    const snapshot = await alerts.evaluateAlerts({
      pool: { totalCount: 2, idleCount: 2, waitingCount: 0 },
      redis: null,
      getQueueDepths: async () => ({ total: 0, byQueue: {} }),
      getDisk: async () => ({ path: '/tmp', free_pct: 80, free_bytes: 1, total_bytes: 2 }),
    });
    expect(snapshot.alerts).toEqual([]);
    expect(snapshot.redis).toBe('not_configured');
  });

  it('fires a critical redis_down alert when the ping rejects', async () => {
    const snapshot = await alerts.evaluateAlerts({
      pool: {},
      redis: { ping: async () => { throw new Error('ECONNREFUSED'); } },
      getQueueDepths: async () => ({ total: 0, byQueue: {} }),
      getDisk: async () => null,
    });
    const redisAlert = snapshot.alerts.find((a) => a.type === 'redis_down');
    expect(redisAlert).toBeTruthy();
    expect(redisAlert.severity).toBe('critical');
    expect(snapshot.redis).toBe('down');
  });

  it('checkDisk tolerates statfs absence/errors without throwing', async () => {
    await expect(alerts.checkDisk()).resolves.not.toThrow;
    const result = await alerts.checkDisk();
    // Either a snapshot object or null (when statfs is unavailable) — never a throw.
    expect(result === null || typeof result === 'object').toBe(true);
  });
});
