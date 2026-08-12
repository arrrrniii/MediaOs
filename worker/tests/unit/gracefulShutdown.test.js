const { createGracefulShutdown } = require('../../src/gracefulShutdown');

const silentLogger = { info() {}, warn() {}, error() {} };

describe('graceful shutdown', () => {
  it('runs every step in order then exits 0', async () => {
    const order = [];
    const exitCodes = [];
    const shutdown = createGracefulShutdown({
      logger: silentLogger,
      exit: (code) => exitCodes.push(code),
      steps: [
        { name: 'a', run: async () => { order.push('a'); } },
        { name: 'b', run: async () => { order.push('b'); } },
        { name: 'c', run: async () => { order.push('c'); } },
      ],
    });

    await shutdown('SIGTERM');
    expect(order).toEqual(['a', 'b', 'c']);
    expect(exitCodes).toEqual([0]);
  });

  it('continues past a throwing step and still exits 0', async () => {
    const order = [];
    const exitCodes = [];
    const shutdown = createGracefulShutdown({
      logger: silentLogger,
      exit: (code) => exitCodes.push(code),
      steps: [
        { name: 'a', run: async () => { order.push('a'); } },
        { name: 'boom', run: async () => { throw new Error('flush failed'); } },
        { name: 'c', run: async () => { order.push('c'); } },
      ],
    });

    await shutdown('SIGTERM');
    expect(order).toEqual(['a', 'c']);
    expect(exitCodes).toEqual([0]);
  });

  it('forces immediate exit(1) on a second signal', async () => {
    const exitCodes = [];
    let releaseFirst;
    const shutdown = createGracefulShutdown({
      logger: silentLogger,
      exit: (code) => exitCodes.push(code),
      steps: [
        { name: 'slow', run: () => new Promise((resolve) => { releaseFirst = resolve; }) },
      ],
    });

    const first = shutdown('SIGTERM');   // starts, blocks on the slow step
    await shutdown('SIGINT');            // second signal while draining
    expect(exitCodes).toContain(1);

    releaseFirst();
    await first;
    expect(exitCodes).toEqual([1, 0]);
  });
});
