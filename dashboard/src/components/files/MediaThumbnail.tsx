'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileIcon, FileAudio, ImageIcon, LoaderCircle, Pause, Play, VideoIcon } from 'lucide-react';
import type { FileRecord } from '@/lib/types';

const AUDIO_PLAY_EVENT = 'mediaos:audio-play';

function formatDuration(seconds: number | null | undefined) {
  if (!seconds || !Number.isFinite(seconds)) return '--:--';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

function waveformFor(seed: string) {
  let value = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }

  return Array.from({ length: 32 }, (_, index) => {
    value ^= index + 1;
    value = Math.imul(value, 2246822519);
    return 18 + (Math.abs(value) % 68);
  });
}

function AudioThumbnail({ file }: { file: FileRecord }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(file.duration || 0);
  const waveform = useMemo(() => waveformFor(file.id || file.filename), [file.id, file.filename]);

  useEffect(() => {
    const pauseWhenAnotherStarts = (event: Event) => {
      const nextId = (event as CustomEvent<string>).detail;
      if (nextId !== file.id && audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
      }
    };
    window.addEventListener(AUDIO_PLAY_EVENT, pauseWhenAnotherStarts);
    return () => window.removeEventListener(AUDIO_PLAY_EVENT, pauseWhenAnotherStarts);
  }, [file.id]);

  async function togglePlayback(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const audio = audioRef.current;
    if (!audio || failed) return;

    if (!audio.paused) {
      audio.pause();
      return;
    }

    window.dispatchEvent(new CustomEvent(AUDIO_PLAY_EVENT, { detail: file.id }));
    setLoading(true);
    try {
      await audio.play();
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  if (!file.url || file.status !== 'done' || failed) {
    return (
      <div className="flex h-full items-center justify-center">
        <FileAudio className="h-8 w-8 text-muted-foreground/50" />
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col justify-center overflow-hidden bg-[radial-gradient(circle_at_50%_115%,hsl(var(--primary)/0.22),transparent_58%)] px-4">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background/20" />

      <div className="relative flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlayback}
          aria-label={`${playing ? 'Pause' : 'Play'} ${file.filename}`}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary text-primary-foreground shadow-lg shadow-primary/20 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {loading ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : playing ? (
            <Pause className="h-4 w-4 fill-current" />
          ) : (
            <Play className="ml-0.5 h-4 w-4 fill-current" />
          )}
        </button>

        <div className="flex h-16 min-w-0 flex-1 items-center gap-[2px]" aria-hidden="true">
          {waveform.map((height, index) => {
            const active = index / waveform.length <= progress;
            return (
              <span
                key={index}
                className={active ? 'w-full rounded-full bg-primary' : 'w-full rounded-full bg-muted-foreground/25'}
                style={{ height: `${height}%` }}
              />
            );
          })}
        </div>
      </div>

      <div className="relative mt-3 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        <span className="flex items-center gap-1.5"><FileAudio className="h-3 w-3" /> {playing ? 'Playing' : 'Audio preview'}</span>
        <span className="font-mono tracking-normal">{formatDuration(duration)}</span>
      </div>

      <audio
        ref={audioRef}
        src={file.url}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
        }}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export default function MediaThumbnail({ file }: { file: FileRecord }) {
  const [failed, setFailed] = useState(false);
  const isImage = file.type === 'image';
  const isVideo = file.type === 'video';
  const isAudio = file.type === 'audio' || file.mime_type?.startsWith('audio/');
  const imageUrl = isImage
    ? (file.urls?.original || file.url)
    : (file.thumbnail_url || file.poster_url);

  if (isAudio) {
    return <AudioThumbnail file={file} />;
  }

  if (!failed && imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={file.filename}
        className="h-full w-full object-cover transition-transform group-hover:scale-105"
        onError={() => setFailed(true)}
      />
    );
  }

  // Raw videos intentionally have no generated poster. Let the browser read a
  // frame from the original MP4 instead, which keeps CDN storage at one object.
  if (!failed && isVideo && file.url && file.status === 'done') {
    return (
      <video
        src={file.url}
        aria-label={file.filename}
        className="h-full w-full object-cover transition-transform group-hover:scale-105"
        preload="metadata"
        muted
        playsInline
        onError={() => setFailed(true)}
      />
    );
  }

  const Icon = isVideo ? VideoIcon : isImage ? ImageIcon : FileIcon;
  return (
    <div className="flex h-full items-center justify-center">
      <Icon className="h-8 w-8 text-muted-foreground/50" />
    </div>
  );
}
