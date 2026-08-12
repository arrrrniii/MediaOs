/**
 * Outbox drain: pending file.* events become durable WEBHOOK jobs (one per
 * subscribed webhook, with an idempotent jobId) and are then marked delivered
 * — all inside one FOR UPDATE SKIP LOCKED transaction. Uses local mocks so no
 * Redis or real DB is touched.
 */

// Records queries and serves canned results based on SQL fragments.
const txQueries = [];
const mockClient = {
  query: jest.fn(async (text, params) => {
    txQueries.push({ text, params });
    if (/FROM outbox_events\s+WHERE status = 'pending'/.test(text) || /FOR UPDATE SKIP LOCKED/.test(text)) {
      return {
        rows: [{
          id: 'evt-1',
          aggregate_type: 'file',
          aggregate_id: 'file-1',
          event_type: 'file.uploaded',
          payload: { id: 'file-1', project_id: 'proj-1' },
          attempts: 0,
        }],
      };
    }
    if (/FROM webhooks/.test(text)) {
      return { rows: [{ id: 'wh-1', url: 'https://example.com/hook', secret: 'whsec_x', events: ['file.uploaded'] }] };
    }
    return { rows: [] };
  }),
};

const mockWithTransaction = jest.fn(async (fn) => fn(mockClient));
const mockQuery = jest.fn(async () => ({ rows: [] }));

jest.mock('../../src/db', () => ({
  query: mockQuery,
  pool: { query: mockQuery, connect: jest.fn() },
  withTransaction: mockWithTransaction,
}));

const mockAddJob = jest.fn(async () => ({ id: 'job-1' }));
jest.mock('../../src/queue', () => ({
  QUEUES: {
    MEDIA: 'media-processing', WEBHOOK: 'webhook-delivery', LIFECYCLE: 'lifecycle',
    ARCHIVE: 'archive', RESTORE: 'restore', RECONCILIATION: 'reconciliation',
    CLEANUP: 'cleanup', OUTBOX: 'outbox',
  },
  DEFAULT_JOB_OPTIONS: { attempts: 5 },
  addJob: mockAddJob,
  getQueue: jest.fn(),
  getConnection: jest.fn(),
  recordJobActive: jest.fn(),
  closeAll: jest.fn(),
}));

const { drainOutbox } = require('../../src/queue/workers');

beforeEach(() => {
  txQueries.length = 0;
  mockClient.query.mockClear();
  mockAddJob.mockClear();
  mockWithTransaction.mockClear();
});

describe('drainOutbox', () => {
  it('enqueues a webhook job per subscriber and marks the event delivered', async () => {
    const count = await drainOutbox();
    expect(count).toBe(1);

    // A durable WEBHOOK job was enqueued with an idempotent jobId.
    expect(mockAddJob).toHaveBeenCalledTimes(1);
    const [queueName, jobName, data, opts] = mockAddJob.mock.calls[0];
    expect(queueName).toBe('webhook-delivery');
    expect(jobName).toBe('deliver');
    expect(data.webhook.id).toBe('wh-1');
    expect(data.event).toBe('file.uploaded');
    expect(data.outboxEventId).toBe('evt-1');
    expect(opts.jobId).toBe('wh:wh-1:evt-1');

    // The event was flipped to delivered.
    const deliveredUpdate = txQueries.find((q) => /SET status = 'delivered'/.test(q.text));
    expect(deliveredUpdate).toBeDefined();
    expect(deliveredUpdate.params).toEqual(['evt-1']);
  });

  it('runs the drain inside a single transaction', async () => {
    await drainOutbox();
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    const selectCall = txQueries.find((q) => /FOR UPDATE SKIP LOCKED/.test(q.text));
    expect(selectCall).toBeDefined();
  });
});
