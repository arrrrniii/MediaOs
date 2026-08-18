'use client';

import type { FileRecord } from '@/lib/types';
import { formatBytes } from '@/lib/utils';
import MediaThumbnail from './MediaThumbnail';

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
        return (
          <div
            key={file.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(file)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(file);
              }
            }}
            className="group cursor-pointer overflow-hidden rounded-lg border bg-card text-left transition-all hover:border-primary/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="aspect-square overflow-hidden bg-muted/50">
              <MediaThumbnail file={file} />
            </div>
            <div className="p-2">
              <p className="truncate text-xs font-medium">{file.filename}</p>
              <p className="text-[10px] text-muted-foreground">
                {formatBytes(file.size)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
