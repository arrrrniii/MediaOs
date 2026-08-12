const { mockDb, mockMinio, testProject } = require('../setup');

// Capture recordAccess so we can assert a 'play' bumps the video-play counter.
jest.mock('../../src/services/accessTrackingService', () => ({
  recordAccess: jest.fn(),
  setRedis: jest.fn(),
}));

const accessTracking = require('../../src/services/accessTrackingService');
const videoService = require('../../src/services/videoService');

const PROJECT = { ...testProject };
const FILE_ID = 'vid-1';
const STORAGE_KEY = 'proj-test-id/clip-x.mp4';

function primeVideoFile(access = 'public') {
  mockDb.onQuery('SELECT id, project_id, storage_key, type, access FROM files', {
    rows: [{ id: FILE_ID, project_id: PROJECT.id, storage_key: STORAGE_KEY, type: 'video', access }],
  });
}

beforeEach(() => {
  mockDb.reset();
  mockMinio.reset();
  accessTracking.recordAccess.mockClear();
});

describe('addSubtitle', () => {
  it('converts SRT to VTT, stores it under the /hls/subs prefix, and upserts a row', async () => {
    primeVideoFile('public');
    mockDb.onQuery('FROM file_objects WHERE file_id', { rows: [] });
    mockDb.onQuery('INSERT INTO subtitles', {
      rows: [{ id: 's1', file_id: FILE_ID, lang: 'en', label: 'English',
        storage_key: 'proj-test-id/clip-x/hls/subs/en.vtt', format: 'vtt', created_at: 'now' }],
    });

    const row = await videoService.addSubtitle({
      project: PROJECT, fileId: FILE_ID, lang: 'en', label: 'English',
      buffer: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi'), format: 'srt', filename: 'en.srt',
    });

    expect(row.lang).toBe('en');
    // Stored as WebVTT at the deterministic key.
    const put = mockMinio.putBufferCalls.find((c) => c.key === 'proj-test-id/clip-x/hls/subs/en.vtt');
    expect(put).toBeDefined();
    expect(put.contentType).toBe('text/vtt');
    expect(put.buffer.toString()).toMatch(/^WEBVTT/);
    expect(put.buffer.toString()).toContain('00:00:01.000 --> 00:00:02.000');
  });

  it('rejects a non-video file', async () => {
    mockDb.onQuery('SELECT id, project_id, storage_key, type, access FROM files', {
      rows: [{ id: FILE_ID, project_id: PROJECT.id, storage_key: 'x.webp', type: 'image', access: 'public' }],
    });
    await expect(videoService.addSubtitle({
      project: PROJECT, fileId: FILE_ID, lang: 'en', buffer: Buffer.from('WEBVTT'), format: 'vtt',
    })).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
  });

  it('rejects an invalid language code', async () => {
    await expect(videoService.addSubtitle({
      project: PROJECT, fileId: FILE_ID, lang: 'not a lang!', buffer: Buffer.from('WEBVTT'), format: 'vtt',
    })).rejects.toMatchObject({ code: 'INVALID_LANG' });
  });
});

describe('buildTracks', () => {
  it('emits plain /f/ URLs for public videos', () => {
    const tracks = videoService.buildTracks(PROJECT, { access: 'public' }, [
      { lang: 'en', label: 'English', storage_key: 'proj-test-id/clip-x/hls/subs/en.vtt', format: 'vtt' },
    ]);
    expect(tracks[0].url).toBe('http://localhost:3000/f/proj-test-id/clip-x/hls/subs/en.vtt');
    expect(tracks[0].url).not.toContain('token=');
  });

  it('signs track URLs for private videos', () => {
    const tracks = videoService.buildTracks(PROJECT, { access: 'private' }, [
      { lang: 'en', label: 'English', storage_key: 'proj-test-id/clip-x/hls/subs/en.vtt', format: 'vtt' },
    ]);
    expect(tracks[0].url).toMatch(/token=[a-f0-9]+&expires=\d+/);
  });
});

describe('recordPlayback', () => {
  it('rejects an unknown event', async () => {
    await expect(videoService.recordPlayback({
      project: PROJECT, fileId: FILE_ID, event: 'explode',
    })).rejects.toMatchObject({ code: 'INVALID_EVENT' });
  });

  it('inserts an event row and bumps video_plays on a play', async () => {
    mockDb.onQuery('SELECT id FROM files WHERE id', { rows: [{ id: FILE_ID }] });
    const res = await videoService.recordPlayback({
      project: PROJECT, fileId: FILE_ID, event: 'play', position: 3.5, sessionId: 'sess-1',
    });
    expect(res).toMatchObject({ recorded: true, event: 'play' });
    const insert = mockDb.queryCalls.find((c) => c.text.includes('INSERT INTO video_playback_events'));
    expect(insert.params).toEqual([FILE_ID, PROJECT.id, 'play', 3.5, 'sess-1']);
    expect(accessTracking.recordAccess).toHaveBeenCalledWith(FILE_ID, 'video_play');
  });

  it('does not bump video_plays for a non-play event', async () => {
    mockDb.onQuery('SELECT id FROM files WHERE id', { rows: [{ id: FILE_ID }] });
    await videoService.recordPlayback({ project: PROJECT, fileId: FILE_ID, event: 'pause', position: 1 });
    expect(accessTracking.recordAccess).not.toHaveBeenCalled();
  });
});

describe('playbackAnalytics', () => {
  it('summarizes counts, plays, and completion rate', async () => {
    mockDb.onQuery('GROUP BY event', { rows: [{ event: 'play', count: 10 }, { event: 'ended', count: 4 }] });
    mockDb.onQuery("date_trunc('day', created_at)", { rows: [{ day: '2026-08-12', plays: 10 }] });

    const summary = await videoService.playbackAnalytics(FILE_ID, { days: 7 });

    expect(summary).toMatchObject({
      file_id: FILE_ID, window_days: 7, plays: 10, completions: 4, completion_rate: 0.4,
    });
    expect(summary.by_event).toEqual({ play: 10, ended: 4 });
    expect(summary.plays_over_time).toEqual([{ day: '2026-08-12', plays: 10 }]);
  });
});
