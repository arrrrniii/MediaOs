/**
 * db.withTransaction — BEGIN/COMMIT on success, ROLLBACK + rethrow on error,
 * and the client is always released. Mocks 'pg' so a fake pool/client can be
 * inspected.
 */

const released = { count: 0 };
const client = {
  queries: [],
  query: jest.fn(async function (text) {
    client.queries.push(text);
    if (text === '__BOOM__') throw new Error('query failed');
    return { rows: [] };
  }),
  release: jest.fn(() => { released.count++; }),
};

const mockPool = {
  connect: jest.fn(async () => client),
  on: jest.fn(),
  query: jest.fn(),
};

jest.mock('pg', () => ({ Pool: jest.fn(() => mockPool) }));

const { withTransaction } = require('../../src/db');

beforeEach(() => {
  client.queries = [];
  client.query.mockClear();
  client.release.mockClear();
  released.count = 0;
});

describe('withTransaction', () => {
  it('commits and returns the callback result on success', async () => {
    const result = await withTransaction(async (c) => {
      await c.query('INSERT INTO foo VALUES (1)');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(client.queries).toEqual(['BEGIN', 'INSERT INTO foo VALUES (1)', 'COMMIT']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and rethrows when the callback throws', async () => {
    await expect(
      withTransaction(async (c) => {
        await c.query('__BOOM__');
      })
    ).rejects.toThrow('query failed');

    expect(client.queries).toContain('BEGIN');
    expect(client.queries).toContain('ROLLBACK');
    expect(client.queries).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
