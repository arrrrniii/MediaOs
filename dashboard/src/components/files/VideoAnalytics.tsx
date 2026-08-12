'use client';

import { useEffect, useState } from 'react';
import type { FileRecord, PlaybackAnalytics } from '@/lib/types';

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export default function VideoAnalytics({ file }: { file: FileRecord }) {
  const [data, setData] = useState<PlaybackAnalytics | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${file.project_id}/files/${file.id}/playback/analytics?days=30`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) { setData(d); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [file.project_id, file.id]);

  if (!loaded) return null;
  if (!data) return null;

  const maxPlays = Math.max(1, ...data.plays_over_time.map((d) => d.plays));

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
        Playback (last {data.window_days}d)
      </p>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Plays" value={data.plays} />
        <Stat label="Completions" value={data.completions} />
        <Stat label="Completion" value={`${Math.round((data.completion_rate || 0) * 100)}%`} />
      </div>

      {data.plays_over_time.length > 0 && (
        <div className="flex h-12 items-end gap-0.5 rounded-md border border-border/50 bg-muted/20 p-2">
          {data.plays_over_time.map((d) => (
            <div
              key={d.day}
              title={`${d.day}: ${d.plays} plays`}
              className="flex-1 rounded-sm bg-primary/60"
              style={{ height: `${Math.max(6, (d.plays / maxPlays) * 100)}%` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
