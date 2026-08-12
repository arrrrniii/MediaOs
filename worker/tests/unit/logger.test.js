const logger = require('../../src/utils/logger');

describe('structured logger', () => {
  function capture(level = 'debug') {
    const lines = [];
    const log = logger.create({ level, sink: (_lvl, line) => lines.push(line) });
    return { log, lines };
  }

  it('emits a single-line JSON record with ts/level/msg and fields', () => {
    const { log, lines } = capture('info');
    log.info('hello', { foo: 'bar', n: 3 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const rec = JSON.parse(lines[0]);
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('hello');
    expect(rec.foo).toBe('bar');
    expect(rec.n).toBe(3);
    expect(typeof rec.ts).toBe('string');
    expect(Number.isNaN(Date.parse(rec.ts))).toBe(false);
  });

  it('gates records below the active level', () => {
    const { log, lines } = capture('warn');
    log.info('skipped');
    log.debug('skipped too');
    log.warn('kept');
    log.error('kept too');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).msg).toBe('kept');
    expect(JSON.parse(lines[1]).msg).toBe('kept too');
  });

  it('child() merges context into every record and keeps parent fields', () => {
    const { log, lines } = capture('info');
    const child = log.child({ request_id: 'abc', method: 'GET' });
    const grandchild = child.child({ path: '/x' });
    grandchild.info('req', { status: 200 });

    const rec = JSON.parse(lines[0]);
    expect(rec.request_id).toBe('abc');
    expect(rec.method).toBe('GET');
    expect(rec.path).toBe('/x');
    expect(rec.status).toBe(200);
  });

  it('routes warn/error to a stderr channel and info/debug to stdout', () => {
    const seen = [];
    const log = logger.create({ level: 'debug', sink: (lvl, line) => seen.push([lvl, JSON.parse(line).msg]) });
    log.info('a');
    log.error('b');
    expect(seen).toEqual([['info', 'a'], ['error', 'b']]);
  });
});
