const request = require('supertest');
const {
  createTestApp,
  mockDb,
  mockSession,
  sessionHeaders,
  MASTER_KEY,
  testProject,
  otherAccount,
  otherUser,
} = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

// User B is a legitimate member of account B. Every request below asks for a
// resource under account A. The worker must answer as if it does not exist.
function sessionB() {
  mockSession({ user: otherUser, account: otherAccount, role: 'owner' });
}

function headersB() {
  return sessionHeaders({ user: otherUser, account: otherAccount });
}

// The account-scoped WHERE means account A's project simply does not match.
function projectMissesScope() {
  mockDb.onQuery('SELECT id, account_id', { rows: [] });
  mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [] });
}

describe('Cross-tenant access', () => {
  it("should 404 on another account's project", async () => {
    sessionB();
    projectMissesScope();

    const res = await request(app)
      .get(`/api/v1/projects/${testProject.id}`)
      .set(headersB());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it("should scope the project lookup to the requesting account", async () => {
    sessionB();
    projectMissesScope();

    await request(app)
      .get(`/api/v1/projects/${testProject.id}`)
      .set(headersB());

    const call = mockDb.queryCalls.find(c => c.text.includes('FROM projects WHERE id'));
    expect(call.params).toEqual([testProject.id, otherAccount.id]);
  });

  it("should 404 listing another account's files", async () => {
    sessionB();
    projectMissesScope();

    const res = await request(app)
      .get(`/api/v1/projects/${testProject.id}/files`)
      .set(headersB());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it("should 404 deleting another account's file", async () => {
    sessionB();
    projectMissesScope();

    const res = await request(app)
      .delete(`/api/v1/projects/${testProject.id}/files/file-test-id`)
      .set(headersB());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it("should 404 listing another account's keys", async () => {
    sessionB();
    projectMissesScope();

    const res = await request(app)
      .get(`/api/v1/projects/${testProject.id}/keys`)
      .set(headersB());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it("should 404 revealing another account's key", async () => {
    sessionB();
    projectMissesScope();

    const res = await request(app)
      .post(`/api/v1/projects/${testProject.id}/keys/key-test-id/reveal`)
      .set(headersB());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    // The reveal query must never run for a project the caller does not own.
    expect(mockDb.queryCalls.some(c => c.text.includes('SELECT encrypted_key'))).toBe(false);
  });

  it("should 404 revoking another account's key", async () => {
    sessionB();
    projectMissesScope();

    const res = await request(app)
      .delete(`/api/v1/projects/${testProject.id}/keys/key-test-id`)
      .set(headersB());

    expect(res.status).toBe(404);
    expect(mockDb.queryCalls.some(c => c.text.includes("UPDATE api_keys SET status = 'revoked'"))).toBe(false);
  });

  it("should 404 listing another account's webhooks", async () => {
    sessionB();
    projectMissesScope();

    const res = await request(app)
      .get(`/api/v1/projects/${testProject.id}/webhooks`)
      .set(headersB());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it("should 404 deleting another account's webhook", async () => {
    sessionB();
    projectMissesScope();

    const res = await request(app)
      .delete(`/api/v1/projects/${testProject.id}/webhooks/wh-test-id`)
      .set(headersB());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it("should 404 reading another account's usage", async () => {
    sessionB();
    projectMissesScope();

    const res = await request(app)
      .get(`/api/v1/projects/${testProject.id}/usage`)
      .set(headersB());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it("should 404 uploading into another account's project", async () => {
    sessionB();
    projectMissesScope();

    const res = await request(app)
      .post(`/api/v1/projects/${testProject.id}/upload`)
      .set(headersB())
      .attach('file', Buffer.from('data'), 'test.png');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it("should never list another account's projects", async () => {
    sessionB();
    mockDb.onQuery('SELECT COUNT', { rows: [{ count: '0' }] });
    mockDb.onQuery('SELECT id, account_id', { rows: [] });

    const res = await request(app)
      .get('/api/v1/projects')
      .set(headersB());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    const countCall = mockDb.queryCalls.find(c => c.text.includes('COUNT'));
    expect(countCall.params).toEqual([otherAccount.id]);
  });
});

describe('MASTER_KEY on customer-scoped routes', () => {
  const customerRoutes = [
    ['get', '/api/v1/projects'],
    ['get', `/api/v1/projects/${testProject.id}`],
    ['patch', `/api/v1/projects/${testProject.id}`],
    ['delete', `/api/v1/projects/${testProject.id}`],
    ['get', `/api/v1/projects/${testProject.id}/keys`],
    ['post', `/api/v1/projects/${testProject.id}/keys`],
    ['delete', `/api/v1/projects/${testProject.id}/keys/key-test-id`],
    ['post', `/api/v1/projects/${testProject.id}/keys/key-test-id/reveal`],
    ['get', `/api/v1/projects/${testProject.id}/files`],
    ['delete', `/api/v1/projects/${testProject.id}/files/file-test-id`],
    ['get', `/api/v1/projects/${testProject.id}/webhooks`],
    ['post', `/api/v1/projects/${testProject.id}/webhooks`],
    ['get', `/api/v1/projects/${testProject.id}/usage`],
    ['get', `/api/v1/projects/${testProject.id}/usage/history`],
  ];

  it.each(customerRoutes)('should reject %s %s', async (method, path) => {
    const res = await request(app)[method](path).set('X-API-Key', MASTER_KEY);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INTERNAL_SECRET_REQUIRED');
  });

  it('should still authorize system-admin account provisioning', async () => {
    mockDb.onQuery('SELECT COUNT', { rows: [{ count: '0' }] });
    mockDb.onQuery('SELECT id, name', { rows: [] });

    const res = await request(app)
      .get('/api/v1/accounts')
      .set('X-API-Key', MASTER_KEY);

    expect(res.status).toBe(200);
  });
});
