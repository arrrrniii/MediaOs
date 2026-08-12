-- ═══════════════════════════════════════════════════════════
--  Video pipeline: HLS adaptive streaming (Phase 8b)
--
--  The physical byte-copies of a video's renditions already live in
--  file_objects (roles video_360p..video_1080p, hls, poster — all present
--  in the 006 role CHECK). This migration adds three small tables that make
--  the PLAYER and the manifest/analytics surfaces cleaner than parsing
--  file_objects roles at read time:
--
--    video_renditions      a per-file summary of the ABR ladder (height,
--                          dimensions, bitrate, codec, media-playlist key)
--                          so the dashboard can list quality levels and the
--                          player can be built without re-deriving them from
--                          role strings.
--    subtitles             uploaded caption/subtitle tracks (WebVTT).
--    video_playback_events lightweight per-event playback analytics.
--
--  Plus a few denormalized flags on files (has_hls, video_status,
--  poster_key) so the common "is this playable, and where's its poster"
--  read needs no join. Every statement is idempotent.
-- ═══════════════════════════════════════════════════════════

-- ── Per-file rendition summary (the ABR ladder) ─────────
-- Convenience mirror of the video_* file_objects: one row per rendition
-- height. The physical objects remain the source of truth for bytes/health;
-- this table is the fast, player-shaped read (what qualities exist, at what
-- resolution/bitrate, and which media playlist to load).
CREATE TABLE IF NOT EXISTS video_renditions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id            UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    height             INTEGER NOT NULL,
    width              INTEGER,
    bitrate            INTEGER,                       -- target video bitrate, bits/s
    codec              VARCHAR(20),
    hls_playlist_key   VARCHAR(500),                  -- storage key of this rendition's media playlist
    status             VARCHAR(20) NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'ready', 'failed')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (file_id, height)
);

CREATE INDEX IF NOT EXISTS idx_video_renditions_file ON video_renditions(file_id);

-- ── Subtitle / caption tracks ───────────────────────────
CREATE TABLE IF NOT EXISTS subtitles (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id      UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    lang         VARCHAR(10) NOT NULL,                -- BCP-47-ish, e.g. 'en', 'en-US'
    label        VARCHAR(60),                         -- human label, e.g. 'English'
    storage_key  VARCHAR(500) NOT NULL,
    format       VARCHAR(10) DEFAULT 'vtt',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (file_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_subtitles_file ON subtitles(file_id);

-- ── Playback analytics events ───────────────────────────
-- Cheap, append-only. 'segment' is high-volume, so callers should sample it;
-- the enum is enforced here so a malformed beacon can never insert garbage.
CREATE TABLE IF NOT EXISTS video_playback_events (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id           UUID NOT NULL,
    project_id        UUID NOT NULL,
    event             VARCHAR(20) NOT NULL
                        CHECK (event IN ('play', 'pause', 'ended', 'seek', 'error', 'segment')),
    position_seconds  REAL,
    session_id        VARCHAR(64),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_playback_events_file ON video_playback_events(file_id, created_at);
CREATE INDEX IF NOT EXISTS idx_video_playback_events_project ON video_playback_events(project_id, created_at);

-- ── Files: denormalized video flags ─────────────────────
ALTER TABLE files ADD COLUMN IF NOT EXISTS has_hls BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE files ADD COLUMN IF NOT EXISTS video_status VARCHAR(20);   -- pending|processing|ready|failed
ALTER TABLE files ADD COLUMN IF NOT EXISTS poster_key VARCHAR(500);

CREATE INDEX IF NOT EXISTS idx_files_has_hls ON files(has_hls) WHERE has_hls;
