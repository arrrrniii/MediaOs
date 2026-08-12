const { mockDb } = require('../setup');

// A controllable storage mockClient + backend, so we assert what the media job
// uploads/removes without touching MinIO. statObject returns the progressive
// mp4's expected size so verification passes; other objects verify against null.
const mockClient = {
  putFile: jest.fn(async () => {}),
  putBuffer: jest.fn(async () => {}),
  getObject: jest.fn(async () => {
    const { Readable } = require('stream');
    const r = new Readable();
    r.push(Buffer.from('source-bytes'));
    r.push(null);
    return r;
  }),
  getPartialObject: jest.fn(),
  statObject: jest.fn(async () => ({ size: 5000, etag: 'e' })),
  removeObject: jest.fn(async () => {}),
};
jest.mock('../../src/services/storageBackendService', () => ({
  getDefaultBackend: jest.fn(async () => ({ id: 'backend-1', type: 'minio', configuration_encrypted: null })),
  getBackendClient: jest.fn(() => mockClient),
  getBackendById: jest.fn(async () => ({ id: 'backend-1', type: 'minio', configuration_encrypted: null })),
  resolveColdBackend: jest.fn(async () => null),
}));

const videoProcessor = require('../../src/services/videoProcessor');
const queue = require('../../src/queue');
const { processMediaJob } = require('../../src/queue/processors/media');

const FILE_ID = 'vid-1';
const FINAL_KEY = 'proj-1/clip-abc123.mp4';
const TEMP_KEY = '_processing_deadbeef.mov';

function jobData(overrides = {}) {
  return {
    fileId: FILE_ID, projectId: 'proj-1', tempKey: TEMP_KEY, finalKey: FINAL_KEY,
    kind: 'video', originalMime: 'video/quicktime', originalExt: '.mov', ...overrides,
  };
}

function project(settings = {}) {
  return {
    id: 'proj-1', account_id: 'acc-1', name: 'P',
    settings, signing_secret: 'a'.repeat(64),
  };
}

// Prime the reads the happy path performs. `status` seeds the file's state;
// `originalPolicy` is written into the project settings.
function primeHappyPath({ status = 'processing', settings = {} } = {}) {
  mockDb.onQuery('SELECT id, status FROM files WHERE id', { rows: [{ id: FILE_ID, status }] });
  mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [project(settings)] });
  // Post-transaction archival guard must see the file still present.
  mockDb.onQuery('SELECT id FROM files WHERE id', { rows: [{ id: FILE_ID }] });
}

function objectRoles() {
  return mockDb.queryCalls
    .filter((c) => c.text.includes('INSERT INTO file_objects'))
    .map((c) => c.params[1]);
}
function renditionHeights() {
  return mockDb.queryCalls
    .filter((c) => c.text.includes('INSERT INTO video_renditions'))
    .map((c) => c.params[1]);
}
function findCall(sub) {
  return mockDb.queryCalls.find((c) => c.text.includes(sub));
}
function auditActions() {
  return mockDb.queryCalls
    .filter((c) => c.text.includes('INSERT INTO lifecycle_audit'))
    .map((c) => c.params[3]);
}

beforeEach(() => {
  mockDb.reset();
  Object.values(mockClient).forEach((fn) => fn.mockReset && fn.mockReset());
  mockClient.putFile.mockResolvedValue(undefined);
  mockClient.putBuffer.mockResolvedValue(undefined);
  mockClient.removeObject.mockResolvedValue(undefined);
  mockClient.getObject.mockImplementation(async () => {
    const { Readable } = require('stream');
    const r = new Readable();
    r.push(Buffer.from('source-bytes'));
    r.push(null);
    return r;
  });
  mockClient.statObject.mockResolvedValue({ size: 5000, etag: 'e' });
  queue.addJob.mockClear();
  queue.isEnabled.mockReturnValue(true);
  videoProcessor.transcodeHls.mockClear();
  videoProcessor.transcodeVideo.mockClear();
  videoProcessor.transcodeVideo.mockResolvedValue({ path: '/tmp/out.mp4', size: 5000 });
  videoProcessor.transcodeHls.mockResolvedValue({
    masterPath: '/tmp/hls/master.m3u8', posterPath: '/tmp/hls/poster.jpg',
    renditions: [
      { height: 360, width: 640, vbitrate: 800000, abitrate: 96000, bandwidth: 952000,
        codecs: 'avc1.4d401f,mp4a.40.2', dir: '/tmp/hls/360p', playlistName: 'index.m3u8',
        playlistPath: '/tmp/hls/360p/index.m3u8', segmentFiles: ['seg_000.ts', 'seg_001.ts'], bytes: 12000 },
      { height: 720, width: 1280, vbitrate: 2800000, abitrate: 128000, bandwidth: 3124000,
        codecs: 'avc1.4d401f,mp4a.40.2', dir: '/tmp/hls/720p', playlistName: 'index.m3u8',
        playlistPath: '/tmp/hls/720p/index.m3u8', segmentFiles: ['seg_000.ts'], bytes: 40000 },
    ],
    duration: 10.5, width: 1280, height: 720, hasAudio: true,
  });
});

describe('processMediaJob — HLS pipeline', () => {
  it('records optimized+thumbnail+poster+hls+video_* objects and sets has_hls', async () => {
    primeHappyPath();

    const result = await processMediaJob(jobData());

    expect(result).toMatchObject({ fileId: FILE_ID, hls: true, renditions: 2 });
    const roles = objectRoles();
    expect(roles).toEqual(expect.arrayContaining(['optimized', 'thumbnail', 'poster', 'hls', 'video_360p', 'video_720p']));
    expect(renditionHeights().sort()).toEqual([360, 720]);
    expect(findCall('has_hls = TRUE')).toBeDefined();
    expect(findCall("video_status = 'ready'")).toBeDefined();

    // Master + segments + playlists all uploaded with deterministic keys.
    const uploaded = mockClient.putFile.mock.calls.map((c) => c[0]);
    expect(uploaded).toContain('proj-1/clip-abc123.mp4');                       // progressive
    expect(uploaded).toContain('proj-1/clip-abc123/hls/master.m3u8');           // master
    expect(uploaded).toContain('proj-1/clip-abc123/hls/720p/index.m3u8');       // media playlist
    expect(uploaded).toContain('proj-1/clip-abc123/hls/360p/seg_001.ts');       // a segment
    expect(uploaded).toContain('proj-1/clip-abc123/hls/poster.jpg');            // poster
  });

  it('records the master.m3u8 object with the HLS content type', async () => {
    primeHappyPath();
    await processMediaJob(jobData());
    const hlsInsert = mockDb.queryCalls.find(
      (c) => c.text.includes('INSERT INTO file_objects') && c.params[1] === 'hls'
    );
    expect(hlsInsert.params[4]).toBe('application/vnd.apple.mpegurl');   // mime_type
    expect(hlsInsert.params[3]).toBe('proj-1/clip-abc123/hls/master.m3u8'); // storage_key
  });

  it('is idempotent: a done file with an hls object skips re-processing', async () => {
    mockDb.onQuery('SELECT id, status FROM files WHERE id', { rows: [{ id: FILE_ID, status: 'done' }] });
    mockDb.onQuery('FROM file_objects WHERE file_id = $1 AND role = $2', {
      rows: [{ id: 'o1', storage_key: 'proj-1/clip-abc123/hls/master.m3u8' }],
    });

    const result = await processMediaJob(jobData());

    expect(result).toEqual({ skipped: 'already_done' });
    expect(videoProcessor.transcodeHls).not.toHaveBeenCalled();
    expect(mockClient.removeObject).toHaveBeenCalledWith(TEMP_KEY);
  });

  it('marks the file failed and removes uploaded objects on a mid-run failure', async () => {
    primeHappyPath();
    // Master upload fails after the progressive/thumb/poster are already up.
    mockClient.putFile.mockImplementation(async (key) => {
      if (key.endsWith('/master.m3u8')) throw new Error('master upload failed');
    });

    await expect(processMediaJob(jobData())).rejects.toThrow(/master upload failed/);

    expect(findCall("status = 'failed', video_status = 'failed'")).toBeDefined();
    // No objects were recorded (recording only happens in the final commit).
    expect(objectRoles()).not.toContain('optimized');
    // Everything uploaded this run was cleaned up.
    const removed = mockClient.removeObject.mock.calls.map((c) => c[0]);
    expect(removed).toContain('proj-1/clip-abc123.mp4');
    expect(removed).toContain('proj-1/clip-abc123/hls/poster.jpg');
    // The SOURCE temp is KEPT for a retry.
    expect(removed).not.toContain(TEMP_KEY);
  });

  it('discards the source (default policy) after renditions are recorded', async () => {
    primeHappyPath({ settings: {} });
    await processMediaJob(jobData());
    expect(auditActions()).toContain('video.source_discarded');
    expect(mockClient.removeObject).toHaveBeenCalledWith(TEMP_KEY);
    // No archive job for a discard policy.
    const archiveCalls = queue.addJob.mock.calls.filter((c) => c[0] === 'archive');
    expect(archiveCalls.length).toBe(0);
  });

  it("archives the source only after renditions are verified, when policy is 'archive'", async () => {
    primeHappyPath({ settings: { original_policy: 'archive' } });
    // The preserved source is verified against its real on-disk size; the
    // downloaded temp ('source-bytes') is 12 bytes, the progressive mp4 5000.
    mockClient.statObject.mockImplementation(async (key) => ({
      size: key === FINAL_KEY ? 5000 : 12, etag: 'e',
    }));
    await processMediaJob(jobData());

    // A 'source' object was recorded and an archive job (scope source) enqueued.
    expect(objectRoles()).toContain('source');
    const archiveCall = queue.addJob.mock.calls.find((c) => c[0] === 'archive');
    expect(archiveCall).toBeDefined();
    expect(archiveCall[2]).toMatchObject({ fileId: FILE_ID, scope: 'source' });
    // The source object was uploaded under its own key before archival.
    const uploaded = mockClient.putFile.mock.calls.map((c) => c[0]);
    expect(uploaded).toContain('proj-1/clip-abc123/source.mov');
  });
});
