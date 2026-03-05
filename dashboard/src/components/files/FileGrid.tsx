'use client';

import type { FileRecord } from '@/lib/types';
import { formatBytes } from '@/lib/utils';
import { FileIcon, ImageIcon, VideoIcon } from 'lucide-react';

const typeIcons: Record<string, typeof FileIcon> = {
  image: ImageIcon,
  video: VideoIcon,
  audio: FileIcon,
  document: FileIcon,
  file: FileIcon,
};

export default function FileGrid({
  files,
  onSelect,
}: {
  files: FileRecord[];
  onSelect: (file: FileRecord) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
      {files.map((file) => {
        const Icon = typeIcons[file.type] || FileIcon;
        const isImage = file.type === 'image';
        const thumbUrl = file.urls?.original || file.url;

        return (
          <button
            key={file.id}
            onClick={() => onSelect(file)}
            className="group overflow-hidden rounded-lg border bg-card text-left transition-all hover:border-primary/30 hover:shadow-md"
          >
            <div className="aspect-square overflow-hidden bg-muted/50">
              {isImage && thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumbUrl}
                  alt={file.filename}
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <Icon className="h-8 w-8 text-muted-foreground/50" />
                </div>
              )}
            </div>
            <div className="p-2">
              <p className="truncate text-xs font-medium">{file.filename}</p>
              <p className="text-[10px] text-muted-foreground">
                {formatBytes(file.size)}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
