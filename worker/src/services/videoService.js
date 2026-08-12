/**
 * Video service — subtitle management, playback analytics, and the track list
 * that gets attached to a video file's API response.
 *
 * Subtitle tracks are stored under the video's own `/hls/subs/` prefix so they
 * inherit the exact access control the HLS serving path applies (public →
 * open, private/signed → tokened). Playback events are cheap append-only rows
 * with a strict event enum; a 'play' also bumps the Phase-5 per-file access
 * counter so video plays roll up alongside downloads/transforms.
 */

const { query } = require('../db');
const config = require('../config');
const storageBackendService = require('./storageBackendService');
const fileObjectService = require('./fileObjectService');
const { recordAccess } = require('./accessTrackingService');
const { generateOriginal } = require('./signedUrl');
const { toVtt } = require('../utils/subtitles');
const crypto = require('crypto');

const PLAYBACK_EVENTS = ['play', 'pause', 'ended', 'seek', 'error', 'segment'];
const MAX_SUBTITLE_BYTES = parseInt(process.env.MAX_SUBTITLE_BYTES || String(2 * 1024 * 1024), 10);

function svcError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function baseKey(storageKey) {
  return storageKey.replace(/\.mp4$/i, '');
}

/** Load a video file scoped to a project, or throw 404/400. */
async function loadVideoFile(fileId, projectId) {
  const { rows } = await query(
    `SELECT id, project_id, storage_key, type, access FROM files
      WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
    [fileId, projectId]
  );
  if (rows.length === 0) throw svcError(404, 'NOT_FOUND', 'File not found');
  if (rows[0].type !== 'video') throw svcError(400, 'INVALID_FILE_TYPE', 'Subtitles are only available for videos');
  return rows[0];
}

/**
 * Store (or replace) a subtitle track for a video. Accepts .vtt or .srt (the
 * latter converted to WebVTT). One track per language (unique file_id, lang).
 */
async function addSubtitle({ project, fileId, buffer, lang, label, format, filename }) {
  if (!buffer || buffer.length === 0) throw svcError(400, 'NO_FILE', 'No subtitle file provided');
  if (buffer.length > MAX_SUBTITLE_BYTES) throw svcError(413, 'FILE_TOO_LARGE', 'Subtitle file is too large');
  const language = String(lang || '').trim().toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(language)) {
    throw svcError(400, 'INVALID_LANG', 'lang must be a BCP-47 language code, e.g. "en" or "en-US"');
  }

  const file = await loadVideoFile(fileId, project.id);
  const vtt = toVtt(buffer, { format, filename });
  const storageKey = `${baseKey(file.storage_key)}/hls/subs/${language}.vtt`;

  const backend = await storageBackendService.getDefaultBackend();
  const client = storageBackendService.getBackendClient(backend);
  await client.putBuffer(storageKey, Buffer.from(vtt, 'utf8'), 'text/vtt');

  const { rows } = await query(
    `INSERT INTO subtitles (file_id, lang, label, storage_key, format)
     VALUES ($1, $2, $3, $4, 'vtt')
     ON CONFLICT (file_id, lang) DO UPDATE
       SET label = EXCLUDED.label, storage_key = EXCLUDED.storage_key, format = 'vtt'
     RETURNING id, file_id, lang, label, storage_key, format, created_at`,
    [fileId, language, label || language, storageKey]
  );

  // Record the physical object so usage accounting + reconciliation see it.
  try {
    const existing = (await fileObjectService.listObjects(fileId))
      .find((o) => o.storage_key === storageKey);
    if (!existing) {
      await fileObjectService.createObject({
        fileId, role: 'source', backendId: backend.id, storageKey,
        mimeType: 'text/vtt', size: Buffer.byteLength(vtt), tier: 'hot', status: 'available',
        metadata: { subtitle: true, lang: language },
      });
    }
  } catch { /* bookkeeping only */ }

  return rows[0];
}

/** List a video's subtitle tracks (rows only). */
async function listSubtitles(fileId) {
  const { rows } = await query(
    `SELECT id, file_id, lang, label, storage_key, format, created_at
       FROM subtitles WHERE file_id = $1 ORDER BY lang ASC`,
    [fileId]
  );
  return rows;
}

/**
 * Build the player-facing track list for a file. Public videos get plain /f/
 * URLs; private/signed videos get per-track SIGNED URLs so the <track> element
 * can fetch them. `project` must carry signing_secret for signed URLs.
 */
function buildTracks(project, file, subtitleRows, expiresIn = 3600) {
  const isPublic = file.access === 'public';
  return (subtitleRows || []).map((s) => {
    let url;
    if (isPublic) {
      url = `${config.publicUrl}/f/${s.storage_key}`;
    } else {
      url = generateOriginal(project, s.storage_key, expiresIn).url;
    }
    return { lang: s.lang, label: s.label || s.lang, url, format: s.format || 'vtt' };
  });
}

/**
 * Build the full playback payload for a video: the HLS master URL, a
 * progressive mp4 fallback, the poster, and the subtitle tracks — each signed
 * when the video is private/signed, plain /f/ URLs when public. This is what
 * the player needs to start, in one call.
 */
async function getPlayback(project, fileId, expiresIn = 3600) {
  const { rows } = await query(
    `SELECT id, storage_key, access, has_hls, poster_key, type FROM files
      WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
    [fileId, project.id]
  );
  if (rows.length === 0) throw svcError(404, 'NOT_FOUND', 'File not found');
  const file = rows[0];
  if (file.type !== 'video') throw svcError(400, 'INVALID_FILE_TYPE', 'Not a video');

  const isPublic = file.access === 'public';
  const url = (key) => (isPublic ? `${config.publicUrl}/f/${key}` : generateOriginal(project, key, expiresIn).url);

  const master = await fileObjectService.getObjectByRole(fileId, 'hls');
  const subs = await listSubtitles(fileId);

  return {
    file_id: fileId,
    has_hls: !!file.has_hls,
    hls_url: master ? url(master.storage_key) : null,
    mp4_url: url(file.storage_key),
    poster_url: file.poster_key ? url(file.poster_key) : null,
    tracks: buildTracks(project, file, subs, expiresIn),
  };
}

/**
 * Record one playback event. Cheap, bounded, validated. A 'play' also bumps
 * the per-file access counter (Phase 5 video_plays) via recordAccess.
 */
async function recordPlayback({ project, fileId, event, position, sessionId }) {
  if (!PLAYBACK_EVENTS.includes(event)) {
    throw svcError(400, 'INVALID_EVENT', `event must be one of: ${PLAYBACK_EVENTS.join(', ')}`);
  }
  // Confirm the file belongs to the project (cheap existence check).
  const { rows } = await query(
    'SELECT id FROM files WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
    [fileId, project.id]
  );
  if (rows.length === 0) throw svcError(404, 'NOT_FOUND', 'File not found');

  const pos = Number.isFinite(Number(position)) ? Number(position) : null;
  const session = sessionId ? String(sessionId).slice(0, 64) : (crypto.randomBytes(8).toString('hex'));

  await query(
    `INSERT INTO video_playback_events (file_id, project_id, event, position_seconds, session_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [fileId, project.id, event, pos, session]
  );

  if (event === 'play') recordAccess(fileId, 'video_play');
  return { recorded: true, event, session_id: session };
}

/**
 * Playback analytics summary for a file: event counts, a plays-over-time
 * series (by day), and a completion estimate (ended / play).
 */
async function playbackAnalytics(fileId, { days = 30 } = {}) {
  const window = Math.min(365, Math.max(1, parseInt(days, 10) || 30));

  const { rows: counts } = await query(
    `SELECT event, COUNT(*)::int AS count
       FROM video_playback_events
      WHERE file_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
      GROUP BY event`,
    [fileId, String(window)]
  );
  const byEvent = {};
  for (const r of counts) byEvent[r.event] = r.count;

  const { rows: series } = await query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE event = 'play')::int AS plays
       FROM video_playback_events
      WHERE file_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
      GROUP BY 1 ORDER BY 1 ASC`,
    [fileId, String(window)]
  );

  const plays = byEvent.play || 0;
  const ended = byEvent.ended || 0;
  return {
    file_id: fileId,
    window_days: window,
    by_event: byEvent,
    plays,
    completions: ended,
    completion_rate: plays > 0 ? Math.round((ended / plays) * 100) / 100 : 0,
    plays_over_time: series,
  };
}

module.exports = {
  addSubtitle,
  listSubtitles,
  buildTracks,
  getPlayback,
  recordPlayback,
  playbackAnalytics,
  loadVideoFile,
  PLAYBACK_EVENTS,
  MAX_SUBTITLE_BYTES,
};
