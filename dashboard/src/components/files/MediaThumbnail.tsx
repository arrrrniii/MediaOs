'use client';

import { useState } from 'react';
import { FileIcon, FileAudio, ImageIcon, VideoIcon } from 'lucide-react';
import type { FileRecord } from '@/lib/types';

export default function MediaThumbnail({ file }: { file: FileRecord }) {
  const [failed, setFailed] = useState(false);
  const isImage = file.type === 'image';
  const isVideo = file.type === 'video';
  const isAudio = file.type === 'audio' || file.mime_type?.startsWith('audio/');
  const imageUrl = isImage
    ? (file.urls?.original || file.url)
    : (file.thumbnail_url || file.poster_url);

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

  const Icon = isVideo ? VideoIcon : isImage ? ImageIcon : isAudio ? FileAudio : FileIcon;
  return (
    <div className="flex h-full items-center justify-center">
      <Icon className="h-8 w-8 text-muted-foreground/50" />
    </div>
  );
}
