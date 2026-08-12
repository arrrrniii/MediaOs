/**
 * outboxService — events must be written on the caller's transaction client
 * (atomic with the state change), and emitEventStandalone must open its own
 * transaction. Uses local mocks (no shared setup) so db is fully controlled.
 */

const mockQuery = jest.fn(async () => ({ rows: [{ id: 'evt-1' }] }));
const mockClient = { query: jest.fn(async () => ({ rows: [{ id: 'evt-tx' }] })) };
const mockWithTransaction = jest.fn(async (fn) => fn(mockClient));

jest.mock('../../src/db', () => ({
  query: mockQuery,
  pool: { query: mockQuery, connect: jest.fn() },
  withTransaction: mockWithTransaction,
}));

const outboxService = require('../../src/services/outboxService');

beforeEach(() => {
  mockQuery.mockClear();
  mockClient.query.mockClear();
  mockWithTransaction.mockClear();
});

describe('outboxService.emitEvent', () => {
  it('inserts an outbox_events row using the passed client', async () => {
    const row = await outboxService.emitEvent(mockClient, {
      aggregateType: 'file',
      aggregateId: 'file-1',
      eventType: 'file.uploaded',
      payload: { id: 'file-1', hello: 'world' },
    });

    expect(row).toEqual({ id: 'evt-tx' });
    // Runs on the transaction client, NOT the pool.
    expect(mockClient.query).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();

    const [sql, params] = mockClient.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO outbox_events/);
    expect(params[0]).toBe('file');
    expect(params[1]).toBe('file-1');
    expect(params[2]).toBe('file.uploaded');
    // payload is serialized JSON
    expect(JSON.parse(params[3])).toEqual({ id: 'file-1', hello: 'world' });
  });

  it('defaults aggregate fields and serializes a null payload to {}', async () => {
    await outboxService.emitEvent(mockClient, { eventType: 'file.failed', payload: null });
    const [, params] = mockClient.query.mock.calls[0];
    expect(params[0]).toBeNull();
    expect(params[1]).toBeNull();
    expect(params[3]).toBe('{}');
  });

  it('throws when eventType is missing', async () => {
    await expect(outboxService.emitEvent(mockClient, { payload: {} })).rejects.toThrow(/eventType/);
  });
});

describe('outboxService.emitEventStandalone', () => {
  it('opens its own transaction and emits within it', async () => {
    const row = await outboxService.emitEventStandalone({
      aggregateType: 'file',
      aggregateId: 'file-9',
      eventType: 'file.deleted',
      payload: { id: 'file-9' },
    });

    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(row).toEqual({ id: 'evt-tx' });
    expect(mockClient.query).toHaveBeenCalledTimes(1);
  });
});
