'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { FileRecord, VideoTrack } from '@/lib/types';

interface PlaybackPayload {
  has_hls: boolean;
  hls_url: string | null;
  mp4_url: string;
  poster_url: string | null;
  tracks: VideoTrack[];
}

interface QualityLevel {
  index: number;   // hls.js level index, or -1 for auto
  label: string;
}

// A stable per-mount session id groups a viewer's events together.
function newSession() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function VideoPlayer({ file }: { file: FileRecord }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<{ destroy: () => void } | null>(null);
  const sessionRef = useRef<string>(newSession());
  const [payload, setPayload] = useState<PlaybackPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<QualityLevel[]>([]);
  const [activeLevel, setActiveLevel] = useState<number>(-1);

  // Fire a playback beacon. Best-effort; a failed beacon never breaks playback.
  const beacon = useCallback(
    (event: string, position?: number) => {
      fetch(`/api/projects/${file.project_id}/files/${file.id}/playback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, position, session_id: sessionRef.current }),
        keepalive: true,
      }).catch(() => {});
    },
    [file.project_id, file.id],
  );

  // Load the (possibly signed) playback URLs.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${file.project_id}/files/${file.id}/hls-url`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Failed to load video'))))
      .then((d: PlaybackPayload) => { if (!cancelled) setPayload(d); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [file.project_id, file.id]);

  // Attach the source: native HLS where available (Safari), hls.js otherwise,
  // and a progressive mp4 fallback when there is no HLS stream at all. hls.js
  // is bundled with the app (not a CDN script), so there is no external fetch.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !payload) return;
    let disposed = false;

    async function attach() {
      if (!video) return;
      const canNativeHls = video.canPlayType('application/vnd.apple.mpegurl');

      if (payload!.has_hls && payload!.hls_url && !canNativeHls) {
        const mod = await import('hls.js');
        const Hls = mod.default;
        if (disposed) return;
        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: true });
          hlsRef.current = hls;
          hls.loadSource(payload!.hls_url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            const opts: QualityLevel[] = [{ index: -1, label: 'Auto' }];
            hls.levels.forEach((l, i) => opts.push({ index: i, label: `${l.height}p` }));
            setLevels(opts);
          });
          hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data: { level: number }) => {
            setActiveLevel(hls.autoLevelEnabled ? -1 : data.level);
          });
          return;
        }
      }

      // Native HLS (Safari) or progressive mp4 fallback.
      video.src = payload!.has_hls && payload!.hls_url && canNativeHls
        ? payload!.hls_url
        : payload!.mp4_url;
    }

    attach();
    return () => {
      disposed = true;
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      setLevels([]);
    };
  }, [payload]);

  function selectLevel(index: number) {
    const hls = hlsRef.current as unknown as { currentLevel: number; autoLevelEnabled: boolean } | null;
    if (!hls) return;
    hls.currentLevel = index; // -1 restores auto
    setActiveLevel(index);
  }

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center text-center text-xs text-muted-foreground">
        {error}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <video
        ref={videoRef}
        controls
        playsInline
        poster={payload?.poster_url || file.poster_url || undefined}
        className="max-h-[50vh] w-full rounded-lg bg-black"
        crossOrigin="anonymous"
        onPlay={(e) => beacon('play', e.currentTarget.currentTime)}
        onPause={(e) => beacon('pause', e.currentTarget.currentTime)}
        onEnded={(e) => beacon('ended', e.currentTarget.currentTime)}
        onSeeked={(e) => beacon('seek', e.currentTarget.currentTime)}
        onError={() => beacon('error')}
      >
        {(payload?.tracks || []).map((t) => (
          <track
            key={t.lang}
            kind="subtitles"
            src={t.url}
            srcLang={t.lang}
            label={t.label}
          />
        ))}
      </video>

      {levels.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground/60">Quality</span>
          {levels.map((l) => (
            <button
              key={l.index}
              onClick={() => selectLevel(l.index)}
              className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                activeLevel === l.index
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border/50 text-muted-foreground hover:bg-muted/50'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
