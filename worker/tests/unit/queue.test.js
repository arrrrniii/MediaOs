const Queue = require('../../src/services/queue');

describe('Queue', () => {
  it('should process jobs sequentially with concurrency 1', async () => {
    const q = new Queue(1);
    const order = [];

    const p1 = q.enqueue('a', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push('a');
      return 'result-a';
    });

    const p2 = q.enqueue('b', async () => {
      order.push('b');
      return 'result-b';
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('result-a');
    expect(r2).toBe('result-b');
    expect(order).toEqual(['a', 'b']);
  });

  it('should process jobs concurrently up to limit', async () => {
    const q = new Queue(3);
    const running = [];
    let maxConcurrent = 0;

    const promises = [];
    for (let i = 0; i < 6; i++) {
      promises.push(q.enqueue(String(i), async () => {
        running.push(i);
        maxConcurrent = Math.max(maxConcurrent, running.length);
        await new Promise(r => setTimeout(r, 30));
        running.splice(running.indexOf(i), 1);
      }));
    }

    await Promise.all(promises);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('should propagate errors', async () => {
    const q = new Queue(2);

    await expect(
      q.enqueue('fail', async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
  });

  it('should track pending and active counts', () => {
    const q = new Queue(1);
    expect(q.active).toBe(0);
    expect(q.pending).toBe(0);
  });
});
