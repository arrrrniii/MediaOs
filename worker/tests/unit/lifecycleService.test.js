const { mockDb } = require('../setup');
const lifecycleService = require('../../src/services/lifecycleService');
const queue = require('../../src/queue');

const project = {
  id: 'proj-1',
  account_id: 'acc-1',
  name: 'Test Project',
  settings: {},
};

function findCall(sub) {
  return mockDb.queryCalls.find((c) => c.text.includes(sub));
}
function auditCall(action) {
  return mockDb.queryCalls.find(
    (c) => c.text.includes('INSERT INTO lifecycle_audit') && c.params[3] === action
  );
}

beforeEach(() => {
  mockDb.reset();
  queue.addJob.mockClear();
});

describe('getLifecyclePolicy', () => {
  it('returns defaults when settings.lifecycle_policy is absent', () => {
    const p = lifecycleService.getLifecyclePolicy({ settings: {} });
    expect(p).toEqual({
      enabled: true,
      inactiveDays: 90,
      inactiveAction: 'review',
      deleteGraceDays: 30,
      autoDelete: false,
      restoreOnAccess: true,
    });
  });

  it('reads overrides and coerces enabled/auto_delete/restore flags', () => {
    const p = lifecycleService.getLifecyclePolicy({
      settings: {
        lifecycle_policy: {
          enabled: false, inactive_days: 30, inactive_action: 'archive',
          delete_grace_days: 7, auto_delete: true, restore_on_access: false,
        },
      },
    });
    expect(p.enabled).toBe(false);
    expect(p.inactiveDays).toBe(30);
    expect(p.inactiveAction).toBe('archive');
    expect(p.deleteGraceDays).toBe(7);
    expect(p.autoDelete).toBe(true);
    expect(p.restoreOnAccess).toBe(false);
  });

  it('falls back to safe defaults for a malformed policy', () => {
    const p = lifecycleService.getLifecyclePolicy({
      settings: { lifecycle_policy: { inactive_days: 'soon', delete_grace_days: null } },
    });
    expect(p.inactiveDays).toBe(90);
    expect(p.deleteGraceDays).toBe(30);
  });
});

describe('scanProject', () => {
  it('short-circuits without touching the DB when policy is disabled', async () => {
    const disabled = { ...project, settings: { lifecycle_policy: { enabled: false } } };
    const r = await lifecycleService.scanProject(disabled);
    expect(r).toEqual({ scanned: false, candidates: 0, totalBytes: 0, coldCandidateBytes: 0, notified: false });
    expect(mockDb.queryCalls).toHaveLength(0);
  });

  it('flags an inactive file cold, writes an audit row, and raises one notification', async () => {
    mockDb.onQuery("lifecycle_state = 'active'", { rows: [{ id: 'f1', last_accessed_at: null }] });
    mockDb.onQuery('FROM file_objects', { rows: [{ file_id: 'f1', total_bytes: '1000', cold_candidate_bytes: '800' }] });
    mockDb.onQuery("UPDATE files SET lifecycle_state = 'cold_candidate'", { rowCount: 1 });

    const r = await lifecycleService.scanProject(project);

    expect(r.candidates).toBe(1);
    expect(r.totalBytes).toBe(1000);
    expect(r.coldCandidateBytes).toBe(800);
    expect(r.notified).toBe(true);

    // The candidate query encodes the skip rules (protected / legal-hold / recent).
    const scan = findCall("lifecycle_state = 'active'");
    expect(scan.text).toContain('protected_from_delete = FALSE');
    expect(scan.text).toContain('last_accessed_at');

    const audit = auditCall('scan.cold_candidate');
    expect(audit).toBeDefined();
    expect(audit.params[5]).toBe('cold_candidate'); // to_state
    expect(audit.params[6]).toBe('system:scanner'); // actor

    expect(findCall('INSERT INTO lifecycle_notifications')).toBeDefined();
  });

  it('is idempotent: a second scan that finds no active candidates writes nothing', async () => {
    mockDb.onQuery("lifecycle_state = 'active'", { rows: [] });

    const r = await lifecycleService.scanProject(project);

    expect(r.candidates).toBe(0);
    expect(r.notified).toBe(false);
    expect(findCall('INSERT INTO lifecycle_audit')).toBeUndefined();
    expect(findCall('INSERT INTO lifecycle_notifications')).toBeUndefined();
  });

  it('does not re-flag a file when the guarded update flips no rows', async () => {
    mockDb.onQuery("lifecycle_state = 'active'", { rows: [{ id: 'f1', last_accessed_at: null }] });
    mockDb.onQuery('FROM file_objects', { rows: [{ file_id: 'f1', total_bytes: '1000', cold_candidate_bytes: '800' }] });
    mockDb.onQuery("UPDATE files SET lifecycle_state = 'cold_candidate'", { rowCount: 0 });

    const r = await lifecycleService.scanProject(project);

    expect(r.candidates).toBe(0);
    expect(r.notified).toBe(false);
    expect(auditCall('scan.cold_candidate')).toBeUndefined();
  });
});

describe('applyAction', () => {
  function primeUpdatedFile(state) {
    mockDb.onQuery('SELECT * FROM files WHERE id = $1', { rows: [{ id: 'f1', lifecycle_state: state }] });
  }

  it('keep → active, with an audit row', async () => {
    primeUpdatedFile('active');
    const updated = await lifecycleService.applyAction(
      { id: 'f1', lifecycle_state: 'cold_candidate' }, project, 'keep', 'user-1'
    );
    expect(updated.lifecycle_state).toBe('active');
    const upd = findCall("UPDATE files SET lifecycle_state = 'active'");
    expect(upd).toBeDefined();
    expect(auditCall('action.keep')).toBeDefined();
  });

  it('protect → active + protected_from_delete, with an audit row', async () => {
    primeUpdatedFile('active');
    await lifecycleService.applyAction(
      { id: 'f1', lifecycle_state: 'cold_candidate' }, project, 'protect', 'user-1'
    );
    expect(findCall('protected_from_delete = TRUE')).toBeDefined();
    expect(auditCall('action.protect')).toBeDefined();
  });

  it('archive_all → archiving, marks every object, and enqueues an ARCHIVE job', async () => {
    primeUpdatedFile('archiving');
    await lifecycleService.applyAction(
      { id: 'f1', lifecycle_state: 'cold_candidate' }, project, 'archive_all', 'user-1'
    );
    expect(findCall("UPDATE files SET lifecycle_state = 'archiving'")).toBeDefined();
    const objUpdate = findCall('UPDATE file_objects');
    expect(objUpdate).toBeDefined();
    expect(objUpdate.text).not.toContain("role = 'source'"); // archive_all touches all roles
    expect(auditCall('action.archive_all')).toBeDefined();
    expect(queue.addJob).toHaveBeenCalledWith(
      'archive', 'archive', expect.objectContaining({ fileId: 'f1', scope: 'all' }), expect.anything()
    );
  });

  it('archive_source → only marks the source object', async () => {
    primeUpdatedFile('archiving');
    await lifecycleService.applyAction(
      { id: 'f1', lifecycle_state: 'cold_candidate' }, project, 'archive_source', 'user-1'
    );
    const objUpdate = findCall('UPDATE file_objects');
    expect(objUpdate.text).toContain("role = 'source'");
    expect(queue.addJob).toHaveBeenCalledWith(
      'archive', 'archive', expect.objectContaining({ scope: 'source' }), expect.anything()
    );
  });

  it('mark_delete → delete_candidate with a retention deadline and audit', async () => {
    primeUpdatedFile('delete_candidate');
    await lifecycleService.applyAction(
      { id: 'f1', lifecycle_state: 'cold_candidate', protected_from_delete: false }, project, 'mark_delete', 'user-1'
    );
    const upd = findCall("lifecycle_state = 'delete_candidate'");
    expect(upd).toBeDefined();
    expect(upd.params[1]).toBeInstanceOf(Date); // retention_until
    expect(auditCall('action.mark_delete')).toBeDefined();
  });

  it('restore → restoring and enqueues a RESTORE job', async () => {
    primeUpdatedFile('restoring');
    await lifecycleService.applyAction(
      { id: 'f1', lifecycle_state: 'archived' }, project, 'restore', 'user-1'
    );
    expect(findCall("UPDATE files SET lifecycle_state = 'restoring'")).toBeDefined();
    expect(auditCall('action.restore')).toBeDefined();
    expect(queue.addJob).toHaveBeenCalledWith(
      'restore', 'restore', expect.objectContaining({ fileId: 'f1' }), expect.anything()
    );
  });

  it('rejects an unknown action', async () => {
    await expect(
      lifecycleService.applyAction({ id: 'f1', lifecycle_state: 'active' }, project, 'nuke', 'user-1')
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_ACTION' });
  });

  it('refuses to mark a protected file for deletion', async () => {
    await expect(
      lifecycleService.applyAction(
        { id: 'f1', lifecycle_state: 'cold_candidate', protected_from_delete: true }, project, 'mark_delete', 'user-1'
      )
    ).rejects.toMatchObject({ status: 403, code: 'FILE_PROTECTED' });
    expect(auditCall('action.mark_delete')).toBeUndefined();
  });

  it('refuses to delete a legal-hold file', async () => {
    await expect(
      lifecycleService.applyAction(
        { id: 'f1', lifecycle_state: 'legal_hold' }, project, 'delete_after_grace', 'user-1'
      )
    ).rejects.toMatchObject({ status: 403, code: 'LEGAL_HOLD' });
  });

  it('delete_after_grace refuses while the grace window is still open', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    await expect(
      lifecycleService.applyAction(
        { id: 'f1', lifecycle_state: 'delete_candidate', retention_until: future, protected_from_delete: false },
        project, 'delete_after_grace', 'user-1'
      )
    ).rejects.toMatchObject({ status: 409, code: 'GRACE_NOT_ELAPSED' });
  });

  it('delete_after_grace deletes once the grace window has elapsed', async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    primeUpdatedFile('deleted');
    await lifecycleService.applyAction(
      { id: 'f1', lifecycle_state: 'delete_candidate', retention_until: past, protected_from_delete: false },
      project, 'delete_after_grace', 'user-1'
    );
    expect(findCall("UPDATE files SET lifecycle_state = 'deleted'")).toBeDefined();
    expect(auditCall('action.delete')).toBeDefined();
  });
});
